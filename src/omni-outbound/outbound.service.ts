import { Injectable, Logger, Inject } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { MessageRepository } from '../omni-inbound/repositories/message.repository';
import { ConversationRepository } from '../omni-inbound/repositories/conversation.repository';
import {
  ChannelAdapter,
  CHANNEL_ADAPTERS,
} from '../omni-inbound/adapters/channel-adapter.interface';
import { ChannelType } from '../omni-inbound/domain/omni-payload';
import { OutboundMedia } from './types/outbound-media.type';
import { FilesService } from '../files/files.service';
import { ImageProcessingService } from '../files/image-processing.service';
import { PLATFORM_LIMITS } from '../files/config/platform-limits.config';
import { mimeToMessageType } from '../common/utils/mime.util';
import { OutboundMediaHandler } from './outbound-media.handler';
import { OutboundEmailHandler } from './outbound-email.handler';

import { ChannelRepository } from '../channels/infrastructure/persistence/document/repositories/channel.repository';
import { ReplyWindowExpiredException } from './exceptions/reply-window-expired.exception';
import replyWindowConfig from './config/reply-window.config';

import { TransportPoolService } from '../channels/transport-pool.service';
import { OutboundQueueService } from '../channels/services/outbound-queue.service';
import { EmailSignatureService } from '../channels/services/email-signature.service';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { EmailContentDocument } from '../channels/infrastructure/persistence/document/entities/email-content.schema';
import { EmailMetadataDocument } from '../channels/infrastructure/persistence/document/entities/email-metadata.schema';
import * as nodemailer from 'nodemailer';
import { ulid } from 'ulid';
import * as cheerio from 'cheerio';
import axios from 'axios';
import type Redis from 'ioredis';
import { IOREDIS_CLIENT } from '../redis/redis.tokens';
import { UsersService } from '../users/users.service';

const OUTBOUND_IDEMPOTENCY_TTL_SECONDS = 86_400;

const normalizeOutboundSource = (source?: string | null): string => {
  switch ((source ?? '').toLowerCase()) {
    case 'outbound':
    case 'socket':
      return 'agent_ui';
    case 'api':
    case 'http':
      return 'crm_api';
    case '':
      return 'crm_api';
    default:
      return source!.toLowerCase();
  }
};

/**
 * OutboundService â€” handles messages sent from Agents to Customers.
 *
 * Responsibilities:
 * 1. Persist the agent's message to the database.
 * 2. Update the conversation's last message and activity timestamp.
 * 3. Send the message to the provider's API (FB, Zalo, WA).
 */
@Injectable()
export class OutboundService {
  private readonly logger = new Logger(OutboundService.name);

  constructor(
    private readonly messageRepo: MessageRepository,
    private readonly conversationRepo: ConversationRepository,
    private readonly channelRepo: ChannelRepository,
    private readonly eventEmitter: EventEmitter2,
    @Inject(CHANNEL_ADAPTERS)
    private readonly adapters: Map<ChannelType, ChannelAdapter>,
    @Inject(replyWindowConfig.KEY)
    private readonly replyWindowCfg: ConfigType<typeof replyWindowConfig>,
    private readonly transportPool: TransportPoolService,
    private readonly outboundQueue: OutboundQueueService,
    private readonly emailSignatureService: EmailSignatureService,
    private readonly usersService: UsersService,
    @InjectModel('EmailContentSchemaClass')
    private readonly emailContentModel: Model<EmailContentDocument>,
    @InjectModel('EmailMetadataSchemaClass')
    private readonly emailMetadataModel: Model<EmailMetadataDocument>,
    @Inject(IOREDIS_CLIENT) private readonly redis: Redis,
    private readonly filesService: FilesService,
    private readonly imageProcessingService: ImageProcessingService,
    // T-040/T-041: Extracted handlers
    private readonly mediaHandler: OutboundMediaHandler,
    private readonly emailHandler: OutboundEmailHandler,
  ) {}

  /**
   * Send a reply from an agent to a customer.
   */
  async sendAgentMessage(params: {
    tenantId: string;
    conversationId: string;
    agentId: string;
    content: string;
    messageType?: string;
    source?: string;
    transport?: 'http' | 'socket';
    idempotencyKey?: string;
    clientMessageId?: string;
  }): Promise<any> {
    const {
      tenantId,
      conversationId,
      agentId,
      content,
      messageType = 'text',
      source: rawSource = 'crm_api',
      transport = 'http',
      idempotencyKey,
      clientMessageId,
    } = params;

    const source = normalizeOutboundSource(rawSource);
    const senderContext = await this.resolveSenderContext(agentId);

    let retryMessage: Awaited<
      ReturnType<MessageRepository['findByIdempotencyKey']>
    > = null;

    if (idempotencyKey) {
      const existing = await this.messageRepo.findByIdempotencyKey(
        tenantId,
        idempotencyKey,
      );
      if (existing && existing.status !== 'failed') {
        return {
          ok: true,
          messageId: existing.id,
          externalMessageId: existing.externalMessageId,
          status: existing.status,
          idempotencyKey,
          clientMessageId: existing.clientMessageId,
          senderId: existing.senderId,
          senderName: existing.senderName ?? senderContext.name,
          senderAvatarUrl:
            existing.senderAvatarUrl ?? senderContext.avatarUrl ?? null,
          source: existing.source ?? source,
          reused: true,
        };
      }
      retryMessage = existing;
    }

    const outboundIdempotencyRedisKey = idempotencyKey
      ? `omni:outbound:idempotency:${tenantId}:${idempotencyKey}`
      : null;
    let reservedIdempotencyKey = false;

    if (outboundIdempotencyRedisKey && !retryMessage) {
      const reserved = await this.redis.set(
        outboundIdempotencyRedisKey,
        'processing',
        'EX',
        OUTBOUND_IDEMPOTENCY_TTL_SECONDS,
        'NX',
      );

      if (reserved === 'OK') {
        reservedIdempotencyKey = true;
      } else {
        const existing = await this.messageRepo.findByIdempotencyKey(
          tenantId,
          idempotencyKey!,
        );
        if (existing && existing.status !== 'failed') {
          return {
            ok: true,
            messageId: existing.id,
            externalMessageId: existing.externalMessageId,
            status: existing.status,
            idempotencyKey,
            clientMessageId: existing.clientMessageId,
            senderId: existing.senderId,
            senderName: existing.senderName ?? senderContext.name,
            senderAvatarUrl:
              existing.senderAvatarUrl ?? senderContext.avatarUrl ?? null,
            source: existing.source ?? source,
            reused: true,
          };
        }
        if (existing) {
          retryMessage = existing;
        } else {
          throw new Error('Duplicate message is already being processed');
        }
      }
    }

    // 1. Fetch conversation to get channel details and external ID
    const conversation = await this.conversationRepo.findById(conversationId);
    if (!conversation) {
      throw new Error(`Conversation ${conversationId} not found`);
    }

    let channel = await this.channelRepo.findByIdWithCredentials(
      tenantId,
      conversation.channelId.toString(),
    );

    // Fallback: If channel record was deleted/re-created, try finding by account
    if (!channel && (conversation as any).channelAccount) {
      this.logger.log(
        `Channel ${conversation.channelId} not found, searching by account ${(conversation as any).channelAccount}`,
      );
      channel = await this.channelRepo.findByAccountWithCredentials(
        tenantId,
        conversation.channelType,
        (conversation as any).channelAccount,
      );
    }

    if (!channel) {
      throw new Error(
        `Channel for conversation ${conversationId} not found or disconnected`,
      );
    }

    // 2. Enforce platform reply window
    this.enforceReplyWindow(conversation);

    // 2b. Auto-assign on reply: if conversation is unassigned, emit event
    // so the inbound module can atomically assign, update presence, and
    // write an audit log — keeping outbound decoupled from assignment infra.
    if (!conversation.assignedAgentId) {
      this.eventEmitter.emit('omni.conversation.reply_auto_assign', {
        tenantId,
        conversationId,
        agentId,
        channelType: conversation.channelType,
      });
    }

    // 2c. Auto-disable bot on agent reply: if bot is still active on
    // this conversation, mark it as ended so the bot stops processing
    // further messages. The channel setting `botAutoDisableOnAgentReply`
    // controls whether this behavior is enabled (defaults to true).
    const botState = (conversation as any).bot;
    if (botState?.enabled === true && botState?.status === 'active') {
      const channelAccount =
        (conversation as any).channelAccount ??
        conversation.channelId?.toString();
      let shouldDisable = true; // default: always disable on agent reply

      try {
        const channelForBot = await this.channelRepo.findByIdWithCredentials(
          tenantId,
          conversation.channelId.toString(),
        );
        if (channelForBot?.config) {
          // Explicit opt-out: set botAutoDisableOnAgentReply = false to keep bot active
          shouldDisable =
            channelForBot.config.botAutoDisableOnAgentReply !== false;
        }
      } catch {
        // If channel lookup fails, still disable bot as safety default
      }

      if (shouldDisable) {
        this.logger.log(
          `[BOT-DISABLE] Agent ${agentId} replied to conv ${conversationId} — disabling active bot`,
        );
        await this.conversationRepo.updateBotState(conversationId, {
          enabled: false,
          status: 'ended',
        });
        this.eventEmitter.emit('omni.bot.disabled', {
          tenantId,
          conversationId,
          reason: 'agent_reply',
          agentId,
        });
      }
    }

    this.logger.log(
      `Agent ${agentId} sending ${messageType} to conversation ${conversationId}`,
    );

    // 3. Persist to MessageRepository
    let message = retryMessage;
    if (message) {
      await this.messageRepo.updateStatus(message.id, 'sending');
    } else {
      try {
        message = await this.messageRepo.create({
          tenantId: tenantId,
          conversationId: conversationId,
          senderId: agentId,
          senderName: senderContext.name,
          senderAvatarUrl: senderContext.avatarUrl ?? undefined,
          senderType: 'agent',
          direction: 'outbound',
          source,
          messageType,
          content,
          status: 'sending',
          idempotencyKey,
          clientMessageId,
          metadata: {
            sender: {
              id: agentId,
              name: senderContext.name,
              avatarUrl: senderContext.avatarUrl ?? null,
              type: 'agent',
            },
            source,
            transport,
          },
        });
      } catch (error) {
        if (idempotencyKey && (error as any)?.code === 11000) {
          const existing = await this.messageRepo.findByIdempotencyKey(
            tenantId,
            idempotencyKey,
          );
          if (existing) {
            return {
              ok: true,
              messageId: existing.id,
              externalMessageId: existing.externalMessageId,
              status: existing.status,
              idempotencyKey,
              clientMessageId: existing.clientMessageId,
              senderId: existing.senderId,
              senderName: existing.senderName ?? senderContext.name,
              senderAvatarUrl:
                existing.senderAvatarUrl ?? senderContext.avatarUrl ?? null,
              source: existing.source ?? source,
              reused: true,
            };
          }
        }
        if (reservedIdempotencyKey && outboundIdempotencyRedisKey) {
          await this.redis.del(outboundIdempotencyRedisKey);
        }
        throw error;
      }
    }

    // 3. Update conversation last message summary
    if (!retryMessage) {
      await this.conversationRepo.updateLastMessage(
        conversationId,
        content.substring(0, 200),
        new Date(),
        'agent',
      );
    }

    // 4. Send to Provider API via Adapter
    try {
      let adapterResponse: any = null;
      const adapter = this.adapters.get(
        conversation.channelType.toLowerCase() as ChannelType,
      );
      if (adapter) {
        adapterResponse = await adapter.send(
          conversation.customer.externalId,
          content,
          messageType,
          {
            credentials: channel.credentials,
            account: channel.account,
            messageId: message.id,
          },
        );
      }

      // Update status to sent and save external ID
      const externalId =
        (adapterResponse as any)?.message_id || (adapterResponse as any)?.id;
      await this.messageRepo.updateStatus(message.id, 'sent', externalId);

      this.eventEmitter.emit('omni.message.sent', {
        tenantId,
        conversationId,
        senderId: agentId,
        senderName: senderContext.name,
        senderAvatarUrl: senderContext.avatarUrl ?? null,
        senderType: 'agent',
        messageType,
        content,
        messageId: message.id,
        externalMessageId: externalId,
        status: 'sent',
        idempotencyKey,
        clientMessageId,
        timestamp: new Date().toISOString(),
        source,
        transport,
      });

      // Livechat: agent reply implies they've read all prior visitor messages.
      // Emit livechat.agent.read so LivechatVisitorBridge persists read status
      // to DB and pushes the receipt to the visitor widget via socket.
      if (conversation.channelType === 'livechat') {
        this.eventEmitter.emit('livechat.agent.read', {
          tenantId,
          conversationId,
          externalConversationId: conversation.externalConversationId,
        });
      }

      return {
        ok: true,
        messageId: message.id,
        externalMessageId: externalId,
        status: 'sent',
        idempotencyKey,
        clientMessageId,
        senderId: agentId,
        senderName: senderContext.name,
        senderAvatarUrl: senderContext.avatarUrl ?? null,
        source,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to send message via provider: ${errorMessage}`);
      await this.messageRepo.updateStatus(message.id, 'failed');
      if (reservedIdempotencyKey && outboundIdempotencyRedisKey) {
        await this.redis.del(outboundIdempotencyRedisKey);
      }
      throw error;
    }
  }

  /**
   * Send a WhatsApp template message from an agent to a customer.
   *
   * Template messages are special: they **bypass the 24-hour reply window**
   * because they are pre-approved by Meta. This is the only way to re-engage
   * a customer after the reply window expires.
   *
   * Flow:
   * 1. Validate template exists and is APPROVED
   * 2. Resolve conversation + channel
   * 3. Persist message with type 'template'
   * 4. Call adapter.sendTemplate() â†’ WhatsApp Cloud API
   * 5. Update status and emit events
   */
  async sendAgentTemplate(params: {
    tenantId: string;
    conversationId: string;
    agentId: string;
    templateName: string;
    languageCode: string;
    components?: any[];
    source?: string;
    transport?: 'http' | 'socket';
    idempotencyKey?: string;
    clientMessageId?: string;
  }): Promise<any> {
    const {
      tenantId,
      conversationId,
      agentId,
      templateName,
      languageCode,
      components = [],
      source: rawSource = 'crm_api',
      transport = 'http',
      idempotencyKey,
      clientMessageId,
    } = params;

    const source = normalizeOutboundSource(rawSource);
    const senderContext = await this.resolveSenderContext(agentId);

    // â”€â”€ Idempotency check â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (idempotencyKey) {
      const existing = await this.messageRepo.findByIdempotencyKey(
        tenantId,
        idempotencyKey,
      );
      if (existing && existing.status !== 'failed') {
        return {
          ok: true,
          messageId: existing.id,
          externalMessageId: existing.externalMessageId,
          status: existing.status,
          idempotencyKey,
          clientMessageId: existing.clientMessageId,
          senderId: existing.senderId,
          senderName: existing.senderName ?? senderContext.name,
          senderAvatarUrl:
            existing.senderAvatarUrl ?? senderContext.avatarUrl ?? null,
          source: existing.source ?? source,
          reused: true,
        };
      }
    }

    // 1. Resolve conversation + channel
    const conversation = await this.conversationRepo.findById(conversationId);
    if (!conversation) {
      throw new Error(`Conversation ${conversationId} not found`);
    }

    if (conversation.channelType !== 'whatsapp') {
      throw new Error(
        `Template messages are only supported for WhatsApp channels (got ${conversation.channelType})`,
      );
    }

    let channel = await this.channelRepo.findByIdWithCredentials(
      tenantId,
      conversation.channelId.toString(),
    );
    if (!channel && (conversation as any).channelAccount) {
      channel = await this.channelRepo.findByAccountWithCredentials(
        tenantId,
        conversation.channelType,
        (conversation as any).channelAccount,
      );
    }
    if (!channel) {
      throw new Error(
        `Channel for conversation ${conversationId} not found or disconnected`,
      );
    }

    // NOTE: Template messages deliberately SKIP enforceReplyWindow().
    // WhatsApp templates are pre-approved by Meta and are the only
    // message type allowed outside the 24-hour customer reply window.

    // 2. Build content summary for display in conversation timeline
    const contentSummary = `ðŸ“‹ Template: ${templateName}`;

    this.logger.log(
      `Agent ${agentId} sending template '${templateName}' to conversation ${conversationId}`,
    );

    // 3. Persist message with type 'template'
    const message = await this.messageRepo.create({
      tenantId,
      conversationId,
      senderId: agentId,
      senderName: senderContext.name,
      senderAvatarUrl: senderContext.avatarUrl ?? undefined,
      senderType: 'agent',
      direction: 'outbound',
      source,
      messageType: 'template',
      content: contentSummary,
      status: 'sending',
      idempotencyKey,
      clientMessageId,
      metadata: {
        sender: {
          id: agentId,
          name: senderContext.name,
          avatarUrl: senderContext.avatarUrl ?? null,
          type: 'agent',
        },
        source,
        transport,
        template: {
          name: templateName,
          language: languageCode,
          components,
        },
      },
    });

    // 4. Update conversation last message summary
    await this.conversationRepo.updateLastMessage(
      conversationId,
      contentSummary.substring(0, 200),
      new Date(),
      'agent',
    );

    // 5. Send via WhatsApp adapter
    try {
      const adapter = this.adapters.get('whatsapp');
      if (!adapter || !adapter.sendTemplate) {
        throw new Error(
          'WhatsApp adapter or sendTemplate method not available',
        );
      }

      const adapterResponse = await adapter.sendTemplate(
        conversation.customer.externalId,
        templateName,
        languageCode,
        components,
        { credentials: channel.credentials, account: channel.account },
      );

      const externalId = adapterResponse?.message_id || adapterResponse?.id;
      await this.messageRepo.updateStatus(message.id, 'sent', externalId);

      this.eventEmitter.emit('omni.message.sent', {
        tenantId,
        conversationId,
        senderId: agentId,
        senderName: senderContext.name,
        senderAvatarUrl: senderContext.avatarUrl ?? null,
        senderType: 'agent',
        direction: 'outbound',
        source,
        messageType: 'template',
        content: contentSummary,
        messageId: message.id,
        externalMessageId: externalId,
        status: 'sent',
        idempotencyKey,
        clientMessageId,
        transport,
        timestamp: new Date().toISOString(),
        createdAt: message.createdAt,
        metadata: message.metadata,
      });

      return {
        ok: true,
        messageId: message.id,
        externalMessageId: externalId,
        status: 'sent',
        idempotencyKey,
        clientMessageId,
        senderId: agentId,
        senderName: senderContext.name,
        senderAvatarUrl: senderContext.avatarUrl ?? null,
        source,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Failed to send WhatsApp template '${templateName}': ${errorMessage}`,
      );
      await this.messageRepo.updateStatus(message.id, 'failed');
      throw error;
    }
  }

  /**
   * Send a media message from an agent to a customer.
   *
   * Flow:
   * 1. Resolve file (from fileId â†’ S3 download, or from buffer)
   * 2. ACL check (if fileId)
   * 3. Validate against platform limits
   * 4. Compress for platform if image
   * 5. Persist message with status 'sending'
   * 6. Call adapter.sendMedia() â†’ update status
   * 7. Create outbound file record
   * 8. Emit events
   */
  /**
   * Send a media message from an agent to a customer.
   * T-040: Delegated to OutboundMediaHandler for separation of concerns.
   */
  async sendAgentMedia(params: {
    tenantId: string;
    conversationId: string;
    agentId: string;
    media: OutboundMedia;
    caption?: string;
    source?: string;
    transport?: 'http' | 'socket';
    idempotencyKey?: string;
    clientMessageId?: string;
  }): Promise<any> {
    return this.mediaHandler.sendAgentMedia(params);
  }

  /**
   * Send a chatbot reply to the customer.
   *
   * The bot service never calls channel providers directly; it returns a reply
   * plan and crm-api owns persistence, provider dispatch, and realtime events.
   */
  async sendBotMessage(params: {
    tenantId: string;
    conversationId: string;
    content: string;
    messageType?: string;
    buttons?: Array<{ id?: string; label: string; value?: string }>;
    idempotencyKey?: string;
    /** Minimum timestamp — bot reply must sort after this (customer msg timestamp) */
    afterTimestamp?: number;
    /** Skip updateLastMessage — caller (processor) handles aggregate update */
    skipAggregateUpdate?: boolean;
  }): Promise<any> {
    const {
      tenantId,
      conversationId,
      content,
      messageType = 'text',
      buttons,
      idempotencyKey,
      afterTimestamp,
    } = params;

    if (idempotencyKey) {
      const existing = await this.messageRepo.findByIdempotencyKey(
        tenantId,
        idempotencyKey,
      );
      if (existing && existing.status !== 'failed') {
        return {
          ok: true,
          messageId: existing.id,
          externalMessageId: existing.externalMessageId,
          status: existing.status,
          idempotencyKey,
          reused: true,
        };
      }
    }

    const conversation = await this.conversationRepo.findById(conversationId);
    if (!conversation) {
      throw new Error(`Conversation ${conversationId} not found`);
    }

    let channel = await this.channelRepo.findByIdWithCredentials(
      tenantId,
      conversation.channelId.toString(),
    );

    if (!channel && (conversation as any).channelAccount) {
      channel = await this.channelRepo.findByAccountWithCredentials(
        tenantId,
        conversation.channelType,
        (conversation as any).channelAccount,
      );
    }

    if (!channel) {
      throw new Error(
        `Channel for conversation ${conversationId} not found or disconnected`,
      );
    }

    this.enforceReplyWindow(conversation);

    const metadata = {
      sender: {
        id: 'bot:typebot',
        name: 'Bot',
        avatarUrl: null,
        type: 'bot',
      },
      source: 'bot',
      provider: 'typebot',
      buttons: buttons ?? [],
    };

    // Guarantee bot reply sorts after the triggering customer message
    const botTimestamp = afterTimestamp
      ? new Date(Math.max(Date.now(), afterTimestamp + 1))
      : new Date();

    let message;
    try {
      message = await this.messageRepo.create({
        tenantId,
        conversationId,
        senderId: 'bot:typebot',
        senderName: 'Bot',
        senderType: 'bot',
        direction: 'outbound',
        source: 'bot',
        messageType,
        content,
        status: 'sending',
        idempotencyKey,
        metadata,
        providerTimestamp: botTimestamp,
      });
    } catch (error) {
      if (idempotencyKey && (error as any)?.code === 11000) {
        const existing = await this.messageRepo.findByIdempotencyKey(
          tenantId,
          idempotencyKey,
        );
        if (existing) {
          return {
            ok: true,
            messageId: existing.id,
            externalMessageId: existing.externalMessageId,
            status: existing.status,
            idempotencyKey,
            reused: true,
          };
        }
      }
      throw error;
    }

    // Skip aggregate update when processor handles it (avoids double write)
    if (!params.skipAggregateUpdate) {
      await this.conversationRepo.updateLastMessage(
        conversationId,
        content.substring(0, 200),
        new Date(),
        'bot',
      );
    }

    try {
      let adapterResponse: any = null;
      const adapter = this.adapters.get(
        conversation.channelType.toLowerCase() as ChannelType,
      );
      if (adapter) {
        // If message has buttons and adapter supports interactive, use interactive
        if (buttons?.length && adapter.sendInteractive) {
          adapterResponse = await adapter.sendInteractive(
            conversation.customer.externalId,
            content,
            buttons.map((b) => ({
              id: b.id || b.value || b.label,
              title: b.label,
            })),
            {
              credentials: channel.credentials,
              account: channel.account,
              messageId: message.id,
            },
          );
        } else {
          // Plain text (or adapter doesn't support interactive)
          const sendContent = buttons?.length
            ? `${content}\n\n${buttons.map((b, i) => `${i + 1}. ${b.label}`).join('\n')}`
            : content;
          adapterResponse = await adapter.send(
            conversation.customer.externalId,
            sendContent,
            messageType,
            {
              credentials: channel.credentials,
              account: channel.account,
              messageId: message.id,
            },
          );
        }
      }

      const externalId =
        (adapterResponse as any)?.message_id || (adapterResponse as any)?.id;
      await this.messageRepo.updateStatus(message.id, 'sent', externalId);

      this.eventEmitter.emit('omni.message.sent', {
        tenantId,
        conversationId,
        senderId: 'bot:typebot',
        senderName: 'Bot',
        senderAvatarUrl: null,
        senderType: 'bot',
        direction: 'outbound',
        messageType,
        content,
        messageId: message.id,
        externalMessageId: externalId,
        status: 'sent',
        idempotencyKey,
        timestamp: new Date().toISOString(),
        source: 'bot',
        transport: 'http',
        metadata,
      });

      return {
        ok: true,
        messageId: message.id,
        externalMessageId: externalId,
        status: 'sent',
        idempotencyKey,
        source: 'bot',
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Failed to send bot message via provider: ${errorMessage}`,
      );
      await this.messageRepo.updateStatus(message.id, 'failed');
      throw error;
    }
  }

  /**
   * Send a bot media message (image, video, audio, file) to the customer.
   *
   * Downloads media from the bot-provided URL and forwards it via the
  /**
   * Send a bot media message. T-040: Delegated to OutboundMediaHandler.
   */
  async sendBotMedia(params: {
    tenantId: string;
    conversationId: string;
    mediaUrl: string;
    mediaType: string;
    mimeType?: string;
    caption?: string;
    idempotencyKey?: string;
    afterTimestamp?: number;
  }): Promise<any> {
    return this.mediaHandler.sendBotMedia(params, (fallbackParams) =>
      this.sendBotMessage(fallbackParams),
    );
  }

  private async resolveSenderContext(agentId: string): Promise<{
    name: string;
    avatarUrl?: string | null;
  }> {
    try {
      const users = await this.usersService.findByIdsGlobal([agentId]);
      const user = users[0];
      if (!user) return { name: 'Agent', avatarUrl: null };

      const fullName = [user.firstName, user.lastName]
        .filter(Boolean)
        .join(' ')
        .trim();

      return {
        name: fullName || user.email || 'Agent',
        avatarUrl: user.photo?.path ?? null,
      };
    } catch (error) {
      this.logger.warn(
        `Failed to resolve sender context for agent ${agentId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { name: 'Agent', avatarUrl: null };
    }
  }

  /**
   * Get the reply window status for a conversation.
   * Used by the frontend to determine whether to lock the chat input.
   */
  getReplyWindowStatus(conversation: {
    channelType: string;
    lastCustomerMessageAt?: Date | null;
  }): {
    isOpen: boolean;
    channelType: string;
    lastCustomerMessageAt: string | null;
    expiresAt: string | null;
    remainingMs: number;
    windowHours: number;
  } {
    const channelKey =
      conversation.channelType.toLowerCase() as keyof typeof this.replyWindowCfg;
    const windowHours = this.replyWindowCfg[channelKey] ?? 24;

    // Unlimited window (e.g. LiveChat)
    if (windowHours === 0) {
      return {
        isOpen: true,
        channelType: conversation.channelType,
        lastCustomerMessageAt: conversation.lastCustomerMessageAt
          ? new Date(conversation.lastCustomerMessageAt).toISOString()
          : null,
        expiresAt: null,
        remainingMs: Infinity,
        windowHours: 0,
      };
    }

    // No customer message yet â€” window is closed
    if (!conversation.lastCustomerMessageAt) {
      return {
        isOpen: false,
        channelType: conversation.channelType,
        lastCustomerMessageAt: null,
        expiresAt: null,
        remainingMs: 0,
        windowHours,
      };
    }

    const lastMsg = new Date(conversation.lastCustomerMessageAt);
    const windowMs = windowHours * 60 * 60 * 1000;
    const expiresAt = new Date(lastMsg.getTime() + windowMs);
    const remainingMs = expiresAt.getTime() - Date.now();

    return {
      isOpen: remainingMs > 0,
      channelType: conversation.channelType,
      lastCustomerMessageAt: lastMsg.toISOString(),
      expiresAt: expiresAt.toISOString(),
      remainingMs: Math.max(0, remainingMs),
      windowHours,
    };
  }

  /**
   * Send an interactive button message from an agent.
   *
   * Persists with messageType 'interactive' and dispatches via adapter.sendInteractive().
   * Adapters that don't support interactive get a numbered text fallback.
   */
  async sendAgentInteractive(params: {
    tenantId: string;
    conversationId: string;
    agentId: string;
    body: string;
    buttons: Array<{ id?: string; title: string; type?: string; url?: string }>;
    source?: string;
    transport?: 'http' | 'socket';
    idempotencyKey?: string;
    clientMessageId?: string;
  }): Promise<any> {
    const {
      tenantId,
      conversationId,
      agentId,
      body,
      buttons,
      source: rawSource = 'crm_api',
      transport = 'http',
      idempotencyKey,
      clientMessageId,
    } = params;

    const source = normalizeOutboundSource(rawSource);
    const senderContext = await this.resolveSenderContext(agentId);

    const conversation = await this.conversationRepo.findById(conversationId);
    if (!conversation)
      throw new Error(`Conversation ${conversationId} not found`);

    this.enforceReplyWindow(conversation);

    // Adapter-specific validation
    const channelType = conversation.channelType.toLowerCase();
    if (channelType === 'whatsapp' && buttons.length > 3) {
      throw new Error(
        'WhatsApp interactive messages support a maximum of 3 buttons',
      );
    }

    let channel = await this.channelRepo.findByIdWithCredentials(
      tenantId,
      conversation.channelId.toString(),
    );
    if (!channel && (conversation as any).channelAccount) {
      channel = await this.channelRepo.findByAccountWithCredentials(
        tenantId,
        conversation.channelType,
        (conversation as any).channelAccount,
      );
    }
    if (!channel)
      throw new Error(
        `Channel for conversation ${conversationId} not found or disconnected`,
      );

    const contentSummary = `${body}\n${buttons.map((b) => `• ${b.title}`).join('\n')}`;

    const message = await this.messageRepo.create({
      tenantId,
      conversationId,
      senderId: agentId,
      senderName: senderContext.name,
      senderAvatarUrl: senderContext.avatarUrl ?? undefined,
      senderType: 'agent',
      direction: 'outbound',
      source,
      messageType: 'interactive',
      content: body,
      status: 'sending',
      idempotencyKey,
      clientMessageId,
      metadata: {
        sender: {
          id: agentId,
          name: senderContext.name,
          avatarUrl: senderContext.avatarUrl ?? null,
          type: 'agent',
        },
        source,
        transport,
        buttons,
      },
    });

    await this.conversationRepo.updateLastMessage(
      conversationId,
      contentSummary.substring(0, 200),
      new Date(),
      'agent',
    );

    try {
      let adapterResponse: any = null;
      const adapter = this.adapters.get(
        conversation.channelType.toLowerCase() as ChannelType,
      );
      if (adapter) {
        if (adapter.sendInteractive) {
          adapterResponse = await adapter.sendInteractive(
            conversation.customer.externalId,
            body,
            buttons.map((b) => ({
              id: b.id || b.title,
              title: b.title,
            })),
            {
              credentials: channel.credentials,
              account: channel.account,
              messageId: message.id,
            },
          );
        } else {
          // Fallback: numbered text
          const fallback = `${body}\n\n${buttons.map((b, i) => `${i + 1}. ${b.title}`).join('\n')}`;
          adapterResponse = await adapter.send(
            conversation.customer.externalId,
            fallback,
            'text',
            {
              credentials: channel.credentials,
              account: channel.account,
              messageId: message.id,
            },
          );
        }
      }

      const externalId =
        (adapterResponse as any)?.message_id || (adapterResponse as any)?.id;
      await this.messageRepo.updateStatus(message.id, 'sent', externalId);

      this.eventEmitter.emit('omni.message.sent', {
        tenantId,
        conversationId,
        senderId: agentId,
        senderName: senderContext.name,
        senderAvatarUrl: senderContext.avatarUrl ?? null,
        senderType: 'agent',
        direction: 'outbound',
        source,
        messageType: 'interactive',
        content: body,
        messageId: message.id,
        externalMessageId: externalId,
        status: 'sent',
        idempotencyKey,
        clientMessageId,
        transport,
        timestamp: new Date().toISOString(),
        createdAt: message.createdAt,
        metadata: message.metadata,
      });

      return {
        ok: true,
        messageId: message.id,
        externalMessageId: externalId,
        status: 'sent',
        idempotencyKey,
        clientMessageId,
        senderId: agentId,
        senderName: senderContext.name,
        senderAvatarUrl: senderContext.avatarUrl ?? null,
        source,
      };
    } catch (error) {
      this.logger.error(
        `Failed to send interactive: ${error instanceof Error ? error.message : String(error)}`,
      );
      await this.messageRepo.updateStatus(message.id, 'failed');
      throw error;
    }
  }

  /**
   * Send a carousel message from an agent.
   *
   * Persists with messageType 'carousel' and dispatches via adapter.sendCarousel().
   * Only Livechat currently supports native carousel; other adapters get a
   * formatted text fallback listing each card.
   */
  async sendAgentCarousel(params: {
    tenantId: string;
    conversationId: string;
    agentId: string;
    content?: string;
    cards: Array<{
      title?: string;
      subtitle?: string;
      imageUrl?: string;
      buttons?: Array<{
        id?: string;
        title: string;
        type?: string;
        url?: string;
      }>;
    }>;
    source?: string;
    transport?: 'http' | 'socket';
    idempotencyKey?: string;
    clientMessageId?: string;
  }): Promise<any> {
    const {
      tenantId,
      conversationId,
      agentId,
      content,
      cards,
      source: rawSource = 'crm_api',
      transport = 'http',
      idempotencyKey,
      clientMessageId,
    } = params;

    const source = normalizeOutboundSource(rawSource);
    const senderContext = await this.resolveSenderContext(agentId);

    const conversation = await this.conversationRepo.findById(conversationId);
    if (!conversation)
      throw new Error(`Conversation ${conversationId} not found`);

    this.enforceReplyWindow(conversation);

    let channel = await this.channelRepo.findByIdWithCredentials(
      tenantId,
      conversation.channelId.toString(),
    );
    if (!channel && (conversation as any).channelAccount) {
      channel = await this.channelRepo.findByAccountWithCredentials(
        tenantId,
        conversation.channelType,
        (conversation as any).channelAccount,
      );
    }
    if (!channel)
      throw new Error(
        `Channel for conversation ${conversationId} not found or disconnected`,
      );

    const contentSummary =
      content || cards.map((c) => c.title).join(' | ') || 'Carousel';

    const message = await this.messageRepo.create({
      tenantId,
      conversationId,
      senderId: agentId,
      senderName: senderContext.name,
      senderAvatarUrl: senderContext.avatarUrl ?? undefined,
      senderType: 'agent',
      direction: 'outbound',
      source,
      messageType: 'carousel',
      content: contentSummary,
      status: 'sending',
      idempotencyKey,
      clientMessageId,
      metadata: {
        sender: {
          id: agentId,
          name: senderContext.name,
          avatarUrl: senderContext.avatarUrl ?? null,
          type: 'agent',
        },
        source,
        transport,
        cards,
      },
    });

    await this.conversationRepo.updateLastMessage(
      conversationId,
      contentSummary.substring(0, 200),
      new Date(),
      'agent',
    );

    try {
      let adapterResponse: any = null;
      const adapter = this.adapters.get(
        conversation.channelType.toLowerCase() as ChannelType,
      );
      if (adapter) {
        if (adapter.sendCarousel) {
          adapterResponse = await adapter.sendCarousel(
            conversation.customer.externalId,
            content,
            cards,
            {
              credentials: channel.credentials,
              account: channel.account,
              messageId: message.id,
            },
          );
        } else {
          // Fallback: formatted text listing each card
          const lines = cards.map(
            (c, i) =>
              `[${i + 1}] ${c.title ?? ''}${c.subtitle ? ` — ${c.subtitle}` : ''}`,
          );
          const fallback = content
            ? `${content}\n\n${lines.join('\n')}`
            : lines.join('\n');
          adapterResponse = await adapter.send(
            conversation.customer.externalId,
            fallback,
            'text',
            {
              credentials: channel.credentials,
              account: channel.account,
              messageId: message.id,
            },
          );
        }
      }

      const externalId =
        (adapterResponse as any)?.message_id || (adapterResponse as any)?.id;
      await this.messageRepo.updateStatus(message.id, 'sent', externalId);

      this.eventEmitter.emit('omni.message.sent', {
        tenantId,
        conversationId,
        senderId: agentId,
        senderName: senderContext.name,
        senderAvatarUrl: senderContext.avatarUrl ?? null,
        senderType: 'agent',
        direction: 'outbound',
        source,
        messageType: 'carousel',
        content: contentSummary,
        messageId: message.id,
        externalMessageId: externalId,
        status: 'sent',
        idempotencyKey,
        clientMessageId,
        transport,
        timestamp: new Date().toISOString(),
        createdAt: message.createdAt,
        metadata: message.metadata,
      });

      return {
        ok: true,
        messageId: message.id,
        externalMessageId: externalId,
        status: 'sent',
        idempotencyKey,
        clientMessageId,
        senderId: agentId,
        senderName: senderContext.name,
        senderAvatarUrl: senderContext.avatarUrl ?? null,
        source,
      };
    } catch (error) {
      this.logger.error(
        `Failed to send carousel: ${error instanceof Error ? error.message : String(error)}`,
      );
      await this.messageRepo.updateStatus(message.id, 'failed');
      throw error;
    }
  }

  /**
   * Guard: throws ReplyWindowExpiredException if the platform reply window
   * has elapsed. Called before persisting or sending any free-form message.
   */
  private enforceReplyWindow(conversation: {
    channelType: string;
    lastCustomerMessageAt?: Date | null;
  }): void {
    const status = this.getReplyWindowStatus(conversation);
    if (!status.isOpen && status.windowHours > 0) {
      throw new ReplyWindowExpiredException(
        status.channelType,
        status.windowHours,
        conversation.lastCustomerMessageAt
          ? new Date(conversation.lastCustomerMessageAt)
          : new Date(0),
        status.expiresAt ? new Date(status.expiresAt) : new Date(),
      );
    }
  }

  /**
   * Send an email reply from the Agent to the Customer.
  /**
   * Send an email reply. T-041: Delegated to OutboundEmailHandler.
   */
  async sendEmailReply(params: {
    tenantId: string;
    conversationId: string;
    agentId: string;
    to: string[];
    cc?: string[];
    bcc?: string[];
    subject: string;
    htmlBody: string;
    inReplyTo?: string;
    references?: string[];
    attachments?: { url: string; filename: string; contentType: string }[];
  }): Promise<any> {
    return this.emailHandler.sendEmailReply(params);
  }
}
