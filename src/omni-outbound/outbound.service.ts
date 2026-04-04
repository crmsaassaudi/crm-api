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

import { ChannelRepository } from '../channels/infrastructure/persistence/document/repositories/channel.repository';
import { ReplyWindowExpiredException } from './exceptions/reply-window-expired.exception';
import replyWindowConfig from './config/reply-window.config';

/**
 * OutboundService — handles messages sent from Agents to Customers.
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
    source?: 'http' | 'socket';
  }): Promise<any> {
    const {
      tenantId,
      conversationId,
      agentId,
      content,
      messageType = 'text',
      source = 'http',
    } = params;

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

    this.logger.log(
      `Agent ${agentId} sending ${messageType} to conversation ${conversationId}`,
    );

    // 3. Persist to MessageRepository
    const message = await this.messageRepo.create({
      tenantId: tenantId,
      conversationId: conversationId,
      senderId: agentId,
      senderType: 'agent',
      messageType,
      content,
      status: 'sending',
    });

    // 3. Update conversation last message summary
    await this.conversationRepo.updateLastMessage(
      conversationId,
      content.substring(0, 200),
      new Date(),
    );

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
          { credentials: channel.credentials, account: channel.account },
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
        senderType: 'agent',
        messageType,
        content,
        messageId: message.id,
        externalMessageId: externalId,
        status: 'sent',
        timestamp: new Date().toISOString(),
        source,
      });

      return { ok: true, messageId: message.id, externalMessageId: externalId };
    } catch (error) {
      this.logger.error(
        `Failed to send message via provider: ${error.message}`,
      );
      await this.messageRepo.updateStatus(message.id, 'failed');
      throw error;
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

    // No customer message yet — window is closed
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
}
