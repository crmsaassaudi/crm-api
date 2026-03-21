import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { OmniPayload } from '../domain/omni-payload';
import { ConversationRepository } from '../repositories/conversation.repository';
import { MessageRepository } from '../repositories/message.repository';
import { MediaProxyService } from './media-proxy.service';

/**
 * ConversationService — listens to `omni.message.received` events and handles:
 *
 * 1. Session management: finds or creates conversations
 * 2. Message persistence: saves each message to MongoDB
 * 3. Media caching: proxies expiring URLs via MediaProxyService
 * 4. Deduplication: skips messages already saved (same externalMessageId)
 */
@Injectable()
export class ConversationService {
  private readonly logger = new Logger(ConversationService.name);

  constructor(
    private readonly conversationRepo: ConversationRepository,
    private readonly messageRepo: MessageRepository,
    private readonly mediaProxy: MediaProxyService,
  ) {}

  /**
   * Event handler: called when a normalized message arrives from any provider.
   */
  @OnEvent('omni.message.received')
  async handleInboundMessage(payload: OmniPayload): Promise<void> {
    try {
      // ── Step 1: Deduplication ──────────────────────────────────
      const alreadyExists = await this.messageRepo.existsByExternalId(
        payload.tenantId,
        payload.externalMessageId,
      );
      if (alreadyExists) {
        this.logger.warn(
          `Duplicate message skipped: ${payload.externalMessageId}`,
        );
        return;
      }

      // ── Step 2: Find or create conversation (session management) ──
      let conversation = await this.conversationRepo.findActiveByExternalId(
        payload.tenantId,
        payload.channelId,
        payload.externalConversationId,
      );

      if (!conversation) {
        // No active session → create a new one
        conversation = await this.conversationRepo.create({
          tenant: payload.tenantId,
          channel: payload.channelId,
          channelType: this.toSchemaChannelType(payload.channelType),
          externalId: payload.externalConversationId,
          customer: {
            externalId: payload.senderId,
            name: payload.metadata.contactName ?? payload.senderId,
            avatarUrl: payload.metadata.avatarUrl ?? undefined,
            phone: payload.metadata.phone ?? undefined,
          },
          status: 'open',
          lastMessage: payload.content,
          lastMessageAt: payload.timestamp,
        });

        this.logger.log(
          `Created new conversation ${conversation._id} ` +
            `for customer ${payload.senderId} on ${payload.channelType}`,
        );
      }

      // ── Step 3: Cache media if present ─────────────────────────
      let mediaProxyUrl: string | undefined;
      if (payload.mediaUrl) {
        mediaProxyUrl = await this.mediaProxy.cacheMedia(
          payload.channelType,
          payload.mediaUrl,
          payload.metadata.mediaId ?? payload.externalMessageId,
          payload.metadata.accessToken,
        );
      }

      // ── Step 4: Save the message ───────────────────────────────
      await this.messageRepo.create({
        tenant: payload.tenantId,
        conversation: conversation._id.toString(),
        senderId: payload.senderId,
        senderType: payload.senderType,
        messageType: payload.messageType,
        content: payload.content,
        mediaUrl: payload.mediaUrl,
        mediaProxyUrl,
        status: 'delivered',
        metadata: payload.metadata,
        externalMessageId: payload.externalMessageId,
      });

      // ── Step 5: Update conversation summary ────────────────────
      const messagePreview =
        payload.content ||
        `[${payload.messageType}]`;

      await this.conversationRepo.updateLastMessage(
        conversation._id.toString(),
        messagePreview.substring(0, 200),
        payload.timestamp,
      );

      this.logger.log(
        `Saved message ${payload.externalMessageId} ` +
          `to conversation ${conversation._id}`,
      );
    } catch (error) {
      // If it's a duplicate key error (race condition), just log and skip
      if (error?.code === 11000) {
        this.logger.warn(
          `Duplicate message (race condition): ${payload.externalMessageId}`,
        );
        return;
      }
      this.logger.error(
        `Failed to handle inbound message: ${error.message}`,
        error.stack,
      );
      throw error; // re-throw so BullMQ can retry
    }
  }

  /**
   * Map lowercase channel types to the schema enum values.
   */
  private toSchemaChannelType(type: string): string {
    const map: Record<string, string> = {
      facebook: 'Facebook',
      instagram: 'Instagram',
      zalo: 'Zalo',
      whatsapp: 'WhatsApp',
      livechat: 'LiveChat',
    };
    return map[type] ?? type;
  }
}
