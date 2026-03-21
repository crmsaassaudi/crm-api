import { Injectable, Logger, Inject } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { MessageRepository } from '../repositories/message.repository';
import { ConversationRepository } from '../repositories/conversation.repository';
import { ChannelAdapter, CHANNEL_ADAPTERS } from '../adapters/channel-adapter.interface';
import { ChannelType } from '../domain/omni-payload';

import { ChannelRepository } from '../../channels/infrastructure/persistence/document/repositories/channel.repository';

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
    const { tenantId, conversationId, agentId, content, messageType = 'text', source = 'http' } = params;

    // 1. Fetch conversation to get channel details and external ID
    const conversation = await this.conversationRepo.findById(conversationId);
    if (!conversation) {
      throw new Error(`Conversation ${conversationId} not found`);
    }

    const channel = await this.channelRepo.findByIdWithCredentials(tenantId, conversation.channel.toString());
    if (!channel) {
      throw new Error(`Channel ${conversation.channel.toString()} not found`);
    }

    this.logger.log(
      `Agent ${agentId} sending ${messageType} to conversation ${conversationId}`,
    );

    // 2. Persist to MessageRepository
    const message = await this.messageRepo.create({
      tenant: tenantId,
      conversation: conversationId,
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
      const adapter = this.adapters.get(conversation.channelType.toLowerCase() as ChannelType);
      if (adapter) {
        await adapter.send(
          conversation.externalId,
          content,
          messageType,
          { credentials: channel.credentials },
        );
      }

      // Update status to sent
      await this.messageRepo.updateStatus(message._id.toString(), 'sent');

      this.eventEmitter.emit('omni.message.sent', {
        tenantId,
        conversationId,
        senderId: agentId,
        senderType: 'agent',
        messageType,
        content,
        messageId: message._id.toString(),
        status: 'sent',
        timestamp: new Date().toISOString(),
        source,
      });

      return { ok: true, messageId: message._id.toString() };
    } catch (error) {
      this.logger.error(`Failed to send message via provider: ${error.message}`);
      await this.messageRepo.updateStatus(message._id.toString(), 'failed');
      throw error;
    }
  }
}
