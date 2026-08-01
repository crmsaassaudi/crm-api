import { Inject, Logger } from '@nestjs/common';
import { Processor } from '@nestjs/bullmq';
import { InjectModel } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Job } from 'bullmq';
import { Model } from 'mongoose';
import { ClsService } from 'nestjs-cls';
import { BaseTenantConsumer } from '../queue/base-tenant.consumer';
import {
  CHANNEL_ADAPTERS,
  ChannelAdapter,
} from '../omni-inbound/adapters/channel-adapter.interface';
import { ChannelType } from '../omni-inbound/domain/omni-payload';
import { ConversationRepository } from '../omni-inbound/repositories/conversation.repository';
import { MessageRepository } from '../omni-inbound/repositories/message.repository';
import { ChannelRepository } from '../channels/infrastructure/persistence/document/repositories/channel.repository';
import {
  DeliveryCommandDocument,
  DeliveryCommandSchemaClass,
} from './infrastructure/delivery-command.schema';
import { DeliveryAttemptService } from './delivery-attempt.service';
import { OMNI_DELIVERY_QUEUE } from './delivery-command.constants';
import { MetricsService } from '../observability/metrics.service';
import { OutboundEmailHandler } from './outbound-email.handler';
import { OutboundMediaHandler } from './outbound-media.handler';
import { OMNI_CONCURRENCY } from '../queue/config/worker-concurrency';

type DeliveryJob = { tenantId: string; commandId: string };

/** Everything resolved before the provider call. */
interface PreparedDelivery {
  conversation: any;
  channel: any;
  adapter: ChannelAdapter | undefined;
}

@Processor(OMNI_DELIVERY_QUEUE, { concurrency: OMNI_CONCURRENCY.delivery() })
export class DeliveryProcessor extends BaseTenantConsumer<DeliveryJob> {
  protected readonly logger = new Logger(DeliveryProcessor.name);
  protected readonly cls: ClsService;

  constructor(
    cls: ClsService,
    @InjectModel(DeliveryCommandSchemaClass.name)
    private readonly commands: Model<DeliveryCommandDocument>,
    private readonly conversations: ConversationRepository,
    private readonly messages: MessageRepository,
    private readonly channels: ChannelRepository,
    private readonly attempts: DeliveryAttemptService,
    private readonly events: EventEmitter2,
    @Inject(CHANNEL_ADAPTERS)
    private readonly adapters: Map<ChannelType, ChannelAdapter>,
    private readonly metrics: MetricsService,
    private readonly emailHandler: OutboundEmailHandler,
    private readonly mediaHandler: OutboundMediaHandler,
  ) {
    super();
    this.cls = cls;
  }

  protected async handle(job: Job<DeliveryJob>): Promise<void> {
    const command = await this.commands
      .findOneAndUpdate(
        {
          _id: job.data.commandId,
          tenantId: job.data.tenantId,
          status: 'pending',
        },
        {
          $set: {
            status: 'processing',
            processingStartedAt: new Date(),
          },
        },
        { new: true },
      )
      .exec();
    if (!command) return;

    // Everything up to the provider call is safe to retry: nothing has been
    // sent, so a transient database blip or a channel that is momentarily
    // unreadable should not cost the customer their message. The command is
    // rewound to `pending` and rethrown so the queue retries it. Treating these
    // the same as a failed send is why an agent had to retype a message after
    // any hiccup in a lookup.
    let prepared: PreparedDelivery;
    try {
      prepared = await this.prepare(command);
    } catch (error) {
      await this.rewindForRetry(command, error);
      throw error;
    }

    const { conversation, channel, adapter } = prepared;
    const conversationChannelType = conversation.channelType;
    let attemptId: string | null = null;
    let response: any;
    try {
      attemptId = await this.attempts.start({
        tenantId: String(command.tenantId),
        messageId: String(command.messageId),
        conversationId: String(command.conversationId),
        channelId: String(conversation.channelId),
        channelType: conversation.channelType,
      });

      response = await this.dispatch(
        adapter,
        command,
        conversation.customer?.externalId ?? '',
        channel,
      );
    } catch (error) {
      const outcome = attemptId
        ? await this.attempts.fail(attemptId, error)
        : 'failed';
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      await this.messages.updateStatus(String(command.messageId), 'failed');
      await this.commands.updateOne(
        { _id: command._id, status: 'processing' },
        {
          $set: {
            status: outcome,
            completedAt: new Date(),
            lastError: errorMessage.substring(0, 2_000),
          },
        },
      );
      this.events.emit('livechat.message.status', {
        tenantId: String(command.tenantId),
        conversationId: String(command.conversationId),
        messageIds: [String(command.messageId)],
        status: 'failed',
      });
      this.logger.error(
        `Delivery command ${String(command._id)} ended as ${outcome}: ${errorMessage}`,
      );
      this.metrics.incrementCounter('crm_omni_deliveries_total', {
        outcome,
        kind: command.kind ?? 'text',
        channel: conversationChannelType,
      });
      return;
    }

    // The provider accepted the message. Record that irreversible fact before
    // updating projections so an internal write failure can never cause a
    // second provider call.
    const externalMessageId = response?.message_id || response?.id || '';
    await this.commands
      .updateOne(
        { _id: command._id, status: 'processing' },
        {
          $set: {
            status: 'completed',
            completedAt: new Date(),
            externalMessageId,
          },
        },
      )
      .exec();

    await this.projectSuccessfulDelivery(
      command,
      attemptId,
      externalMessageId,
      conversationChannelType,
      response,
    );
  }

  /**
   * Resolve everything the send needs. Nothing here talks to the provider, so
   * every failure it raises is safe to retry.
   */
  private async prepare(
    command: DeliveryCommandDocument,
  ): Promise<PreparedDelivery> {
    const conversation = await this.conversations.findById(
      String(command.conversationId),
    );
    if (!conversation) throw new Error('Conversation no longer exists');

    let channel = await this.channels.findByIdWithCredentials(
      String(command.tenantId),
      String(conversation.channelId),
    );
    if (!channel && conversation.channelAccount) {
      channel = await this.channels.findByAccountWithCredentials(
        String(command.tenantId),
        conversation.channelType,
        conversation.channelAccount,
      );
    }
    if (!channel) throw new Error('Channel is disconnected or unavailable');

    const adapter =
      command.kind === 'email'
        ? undefined
        : this.adapters.get(
            conversation.channelType.toLowerCase() as ChannelType,
          );
    if (command.kind !== 'email' && !adapter) {
      throw new Error(
        `No outbound adapter registered for ${conversation.channelType}`,
      );
    }

    return { conversation, channel, adapter };
  }

  /**
   * Put a command back in the queue's hands after a failure that happened
   * before the provider was called.
   *
   * Only `processing` is rewound, so a command that somehow advanced further is
   * left alone rather than being sent twice.
   */
  private async rewindForRetry(
    command: DeliveryCommandDocument,
    error: unknown,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    await this.commands
      .updateOne(
        { _id: command._id, status: 'processing' },
        {
          $set: { status: 'pending', lastError: message.substring(0, 2_000) },
          $unset: { processingStartedAt: '' },
        },
      )
      .exec();
    this.logger.warn(
      `Delivery command ${String(command._id)} will retry — failed before dispatch: ${message}`,
    );
  }

  private dispatch(
    adapter: ChannelAdapter | undefined,
    command: DeliveryCommandDocument,
    recipientId: string,
    channel: any,
  ): Promise<any> {
    const context = {
      credentials: channel.credentials,
      account: channel.account,
      messageId: String(command.messageId),
    };
    const payload = command.payload ?? {};

    switch (command.kind) {
      case 'email':
        return this.emailHandler.dispatchDeliveryCommand({
          tenantId: String(command.tenantId),
          conversationId: String(command.conversationId),
          agentId: command.agentId,
          messageId: String(command.messageId),
          payload: command.payload as any,
        });
      case 'media':
        return this.mediaHandler.dispatchDeliveryCommand({
          tenantId: String(command.tenantId),
          conversationId: String(command.conversationId),
          agentId: command.agentId,
          messageId: String(command.messageId),
          payload: command.payload as any,
        });
      case 'template':
        if (!adapter) throw new Error('Channel adapter is required');
        if (!adapter.sendTemplate) {
          throw new Error('Channel adapter does not support templates');
        }
        return adapter.sendTemplate(
          recipientId,
          payload.templateName,
          payload.languageCode,
          payload.components ?? [],
          context,
        );
      case 'interactive':
        if (!adapter) throw new Error('Channel adapter is required');
        if (adapter.sendInteractive) {
          return adapter.sendInteractive(
            recipientId,
            payload.body,
            payload.buttons ?? [],
            context,
          );
        }
        return adapter.send(
          recipientId,
          this.interactiveFallback(payload.body, payload.buttons ?? []),
          'text',
          context,
        );
      case 'carousel':
        if (!adapter) throw new Error('Channel adapter is required');
        if (adapter.sendCarousel) {
          return adapter.sendCarousel(
            recipientId,
            payload.content,
            payload.cards ?? [],
            context,
          );
        }
        return adapter.send(
          recipientId,
          this.carouselFallback(payload.content, payload.cards ?? []),
          'text',
          context,
        );
      case 'text':
      default:
        if (!adapter) throw new Error('Channel adapter is required');
        return adapter.send(
          recipientId,
          command.content,
          command.messageType,
          context,
        );
    }
  }

  private interactiveFallback(
    body: string,
    buttons: Array<{ title?: string }>,
  ): string {
    const options = buttons
      .map((button, index) => `${index + 1}. ${button.title ?? ''}`)
      .join('\n');
    return options ? `${body}\n\n${options}` : body;
  }

  private carouselFallback(
    content: string | undefined,
    cards: Array<{ title?: string; subtitle?: string }>,
  ): string {
    const items = cards
      .map(
        (card, index) =>
          `[${index + 1}] ${card.title ?? ''}${
            card.subtitle ? ` — ${card.subtitle}` : ''
          }`,
      )
      .join('\n');
    return content ? `${content}\n\n${items}` : items;
  }

  private async projectSuccessfulDelivery(
    command: DeliveryCommandDocument,
    attemptId: string | null,
    externalMessageId: string,
    channelType: string,
    response?: any,
  ): Promise<void> {
    const failures: string[] = [];
    if (attemptId) {
      try {
        await this.attempts.succeed(attemptId, externalMessageId);
      } catch (error) {
        failures.push(
          `attempt: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    try {
      await this.messages.updateStatus(
        String(command.messageId),
        'sent',
        externalMessageId,
      );
    } catch (error) {
      failures.push(
        `message: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (command.kind === 'email' && response?.emailProjection) {
      try {
        await this.emailHandler.projectSuccessfulDelivery(
          response.emailProjection,
        );
      } catch (error) {
        failures.push(
          `email: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    this.events.emit('omni.message.sent', {
      tenantId: String(command.tenantId),
      conversationId: String(command.conversationId),
      senderId: command.agentId,
      senderType: 'agent',
      direction: 'outbound',
      source: command.source,
      transport: command.transport,
      messageType: command.messageType,
      channelType,
      content: command.content,
      messageId: String(command.messageId),
      externalMessageId,
      status: 'sent',
      idempotencyKey: command.idempotencyKey,
      clientMessageId: command.clientMessageId,
      timestamp: new Date().toISOString(),
    });
    this.metrics.incrementCounter('crm_omni_deliveries_total', {
      outcome: failures.length ? 'projection_pending' : 'succeeded',
      kind: command.kind ?? 'text',
      channel: channelType,
    });
    if (failures.length) {
      this.logger.error(
        `Delivery command ${String(command._id)} completed but projections need repair: ${failures.join('; ')}`,
      );
    }
  }
}
