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
   * 4. Call adapter.sendTemplate() → WhatsApp Cloud API
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

    // ── Idempotency check ──────────────────────────────────────────
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
    const contentSummary = `📋 Template: ${templateName}`;

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
   * 1. Resolve file (from fileId → S3 download, or from buffer)
   * 2. ACL check (if fileId)
   * 3. Validate against platform limits
   * 4. Compress for platform if image
   * 5. Persist message with status 'sending'
   * 6. Call adapter.sendMedia() → update status
   * 7. Create outbound file record
   * 8. Emit events
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
    const {
      tenantId,
      conversationId,
      agentId,
      media,
      caption = '',
      source: rawSource = 'crm_api',
      transport = 'http',
      idempotencyKey,
      clientMessageId,
    } = params;

    const source = normalizeOutboundSource(rawSource);
    const senderContext = await this.resolveSenderContext(agentId);

    // 1. Resolve conversation + channel
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

    // 2. Resolve media buffer
    let mediaBuffer: Buffer;
    if (media.fileId) {
      // Resolve from existing file
      const file = await this.filesService.findById(media.fileId);
      if (!file) throw new Error(`File ${media.fileId} not found`);
      if (!this.filesService.checkAccess(file, agentId, 'AGENT')) {
        throw new Error('No access to this file');
      }
      // Download from S3
      const downloadUrl = await this.filesService.getPresignedDownloadUrl(
        file.path,
        300,
      );
      const response = await fetch(downloadUrl);
      if (!response.ok) throw new Error('Failed to download file from S3');
      mediaBuffer = Buffer.from(await response.arrayBuffer());
      media.mimeType =
        media.mimeType || file.mimeType || 'application/octet-stream';
      media.fileName = media.fileName || file.fileName || 'file';
      media.size = mediaBuffer.length;
    } else if (media.buffer) {
      mediaBuffer = media.buffer;
    } else {
      throw new Error('Either fileId or buffer must be provided');
    }

    // 3. Validate against platform limits
    const channelKey = conversation.channelType.toLowerCase() as ChannelType;
    const platformLimits = PLATFORM_LIMITS[channelKey];
    if (platformLimits) {
      const isImage = media.mimeType.startsWith('image/');
      const limit = isImage ? platformLimits.image : platformLimits.file;
      if (limit && mediaBuffer.length > limit.maxBytes) {
        throw new Error(
          `File size ${(mediaBuffer.length / (1024 * 1024)).toFixed(1)}MB exceeds ${channelKey} limit of ${(limit.maxBytes / (1024 * 1024)).toFixed(0)}MB`,
        );
      }
    }

    // 4. Compress for platform if image
    let sendBuffer = mediaBuffer;
    if (
      media.mimeType.startsWith('image/') &&
      this.imageProcessingService.isProcessableImage(media.mimeType)
    ) {
      try {
        const compressed =
          await this.imageProcessingService.compressForPlatform(
            mediaBuffer,
            channelKey,
          );
        sendBuffer = compressed.buffer;
        this.logger.log(
          `Compressed image for ${channelKey}: ${(mediaBuffer.length / 1024).toFixed(0)}KB → ${(sendBuffer.length / 1024).toFixed(0)}KB`,
        );
      } catch (err) {
        this.logger.warn(
          `Platform compression failed, using original: ${(err as Error).message}`,
        );
      }
    }

    // 5. Determine message type
    const messageType = this.getMediaMessageType(media.mimeType);

    // 6. Persist message
    const message = await this.messageRepo.create({
      tenantId,
      conversationId,
      senderId: agentId,
      senderName: senderContext.name,
      senderAvatarUrl: senderContext.avatarUrl ?? undefined,
      senderType: 'agent',
      direction: 'outbound',
      source,
      messageType,
      content: caption || `[${messageType}] ${media.fileName}`,
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
        media: {
          fileName: media.fileName,
          mimeType: media.mimeType,
          size: sendBuffer.length,
          fileId: media.fileId,
        },
      },
    });

    // Update conversation last message
    await this.conversationRepo.updateLastMessage(
      conversationId,
      caption || `📎 ${media.fileName}`,
      new Date(),
      'agent',
    );

    // 7. Send via adapter
    try {
      const adapter = this.adapters.get(channelKey);
      let externalId: string | undefined;

      if (adapter?.sendMedia) {
        // Adapter supports media sending
        const sendMediaPayload: OutboundMedia = {
          ...media,
          buffer: sendBuffer,
          size: sendBuffer.length,
          caption,
        };
        const result = await adapter.sendMedia(
          conversation.customer.externalId,
          sendMediaPayload,
          { credentials: channel.credentials, account: channel.account },
        );
        externalId = result.externalMessageId;
        if (!result.success) {
          throw new Error(result.error || 'Adapter sendMedia failed');
        }
      } else if (adapter) {
        // Fallback: send as text with download link
        const downloadUrl = media.fileId
          ? await this.filesService.getPresignedDownloadUrl(
              media.storageKey || '',
              3600,
            )
          : '';
        const fallbackContent =
          caption ||
          `📎 ${media.fileName}${downloadUrl ? '\n' + downloadUrl : ''}`;
        const adapterResponse = await adapter.send(
          conversation.customer.externalId,
          fallbackContent,
          'text',
          { credentials: channel.credentials, account: channel.account },
        );
        externalId =
          (adapterResponse as any)?.message_id || (adapterResponse as any)?.id;
      }

      await this.messageRepo.updateStatus(message.id, 'sent', externalId);

      this.eventEmitter.emit('omni.message.sent', {
        tenantId,
        conversationId,
        senderId: agentId,
        senderName: senderContext.name,
        senderAvatarUrl: senderContext.avatarUrl ?? null,
        senderType: 'agent',
        messageType,
        content: caption || `[${messageType}] ${media.fileName}`,
        messageId: message.id,
        externalMessageId: externalId,
        status: 'sent',
        idempotencyKey,
        clientMessageId,
        timestamp: new Date().toISOString(),
        source,
        transport,
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
        source,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to send media via provider: ${errorMessage}`);
      await this.messageRepo.updateStatus(message.id, 'failed');
      throw error;
    }
  }

  private getMediaMessageType(mimeType: string): string {
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('video/')) return 'video';
    if (mimeType.startsWith('audio/')) return 'audio';
    return 'file';
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
  }): Promise<any> {
    const {
      tenantId,
      conversationId,
      content,
      messageType = 'text',
      buttons,
      idempotencyKey,
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

    await this.conversationRepo.updateLastMessage(
      conversationId,
      content.substring(0, 200),
      new Date(),
      'bot',
    );

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
            { credentials: channel.credentials, account: channel.account },
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
            { credentials: channel.credentials, account: channel.account },
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
   * channel adapter's sendMedia method. Falls back to text link if
   * the adapter doesn't support media.
   */
  async sendBotMedia(params: {
    tenantId: string;
    conversationId: string;
    mediaUrl: string;
    mediaType: string;
    mimeType?: string;
    caption?: string;
    idempotencyKey?: string;
  }): Promise<any> {
    const {
      tenantId,
      conversationId,
      mediaUrl,
      mimeType: rawMimeType,
      caption = '',
      idempotencyKey,
    } = params;

    if (idempotencyKey) {
      const existing = await this.messageRepo.findByIdempotencyKey(
        tenantId,
        idempotencyKey,
      );
      if (existing && existing.status !== 'failed') {
        return { ok: true, messageId: existing.id, reused: true };
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

    // Download media from bot URL
    let mediaBuffer: Buffer;
    let mimeType = rawMimeType || 'application/octet-stream';
    let fileName = 'bot-media';

    try {
      const response = await fetch(mediaUrl, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        throw new Error(`Failed to download: ${response.status}`);
      }
      mediaBuffer = Buffer.from(await response.arrayBuffer());

      // Infer mime type from response if not provided
      const contentType = response.headers.get('content-type');
      if (contentType && mimeType === 'application/octet-stream') {
        mimeType = contentType.split(';')[0].trim();
      }

      // Extract filename from URL
      try {
        const pathname = new URL(mediaUrl).pathname;
        const basename = pathname.split('/').pop();
        if (basename && basename.includes('.')) fileName = basename;
      } catch {
        /* ignore */
      }
    } catch (error) {
      this.logger.warn(
        `Bot media download failed for ${mediaUrl}: ${error instanceof Error ? error.message : error}. Falling back to link.`,
      );
      // Fallback: send URL as text
      return this.sendBotMessage({
        tenantId,
        conversationId,
        content: caption ? `${caption}\n${mediaUrl}` : mediaUrl,
        messageType: 'text',
        idempotencyKey,
      });
    }

    const resolvedMessageType = this.getMediaMessageType(mimeType);

    // Persist message
    const message = await this.messageRepo.create({
      tenantId,
      conversationId,
      senderId: 'bot:typebot',
      senderName: 'Bot',
      senderType: 'bot',
      direction: 'outbound',
      source: 'bot',
      messageType: resolvedMessageType,
      content: caption || `[${resolvedMessageType}] ${fileName}`,
      status: 'sending',
      idempotencyKey,
      metadata: {
        sender: {
          id: 'bot:typebot',
          name: 'Bot',
          avatarUrl: null,
          type: 'bot',
        },
        source: 'bot',
        provider: 'typebot',
        media: { fileName, mimeType, size: mediaBuffer.length },
      },
    });

    await this.conversationRepo.updateLastMessage(
      conversationId,
      caption || `📎 ${fileName}`,
      new Date(),
      'bot',
    );

    try {
      const channelKey = conversation.channelType.toLowerCase() as ChannelType;
      const adapter = this.adapters.get(channelKey);
      let externalId: string | undefined;

      if (adapter?.sendMedia) {
        const result = await adapter.sendMedia(
          conversation.customer.externalId,
          {
            buffer: mediaBuffer,
            mimeType,
            fileName,
            size: mediaBuffer.length,
            caption,
          },
          { credentials: channel.credentials, account: channel.account },
        );
        externalId = result.externalMessageId;
        if (!result.success) {
          throw new Error(result.error || 'Adapter sendMedia failed');
        }
      } else if (adapter) {
        // Fallback: send as text with media URL
        const fallbackContent = caption
          ? `${caption}\n${mediaUrl}`
          : `📎 ${fileName}\n${mediaUrl}`;
        const resp = await adapter.send(
          conversation.customer.externalId,
          fallbackContent,
          'text',
          { credentials: channel.credentials, account: channel.account },
        );
        externalId = resp?.message_id || resp?.id;
      }

      await this.messageRepo.updateStatus(message.id, 'sent', externalId);

      this.eventEmitter.emit('omni.message.sent', {
        tenantId,
        conversationId,
        senderId: 'bot:typebot',
        senderName: 'Bot',
        senderAvatarUrl: null,
        senderType: 'bot',
        direction: 'outbound',
        messageType: resolvedMessageType,
        content: caption || `[${resolvedMessageType}] ${fileName}`,
        messageId: message.id,
        externalMessageId: externalId,
        status: 'sent',
        idempotencyKey,
        timestamp: new Date().toISOString(),
        source: 'bot',
        transport: 'http',
      });

      return { ok: true, messageId: message.id, status: 'sent' };
    } catch (error) {
      this.logger.error(
        `Failed to send bot media: ${error instanceof Error ? error.message : error}`,
      );
      await this.messageRepo.updateStatus(message.id, 'failed');
      throw error;
    }
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

  /**
   * Send an email reply from the Agent to the Customer.
   * Processes S3 inline images natively via Axios streaming into Nodemailer CIDs.
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
    const {
      tenantId,
      conversationId,
      agentId,
      to,
      cc = [],
      bcc = [],
      subject,
      htmlBody,
      inReplyTo,
      references = [],
      attachments: standardAttachments = [],
    } = params;
    const senderContext = await this.resolveSenderContext(agentId);

    const conversation = await this.conversationRepo.findById(conversationId);
    if (!conversation) {
      throw new Error(`Conversation ${conversationId} not found`);
    }

    // 1. Resolve SMTP config from TransportPool
    const channelId = conversation.channelId.toString();
    const transportConfig = await this.transportPool.resolveWithTenantGuard(
      channelId,
      tenantId,
    );

    if (!transportConfig || transportConfig.providerType !== 'smtp') {
      throw new Error('Invalid or missing SMTP configuration for this channel');
    }

    const { user, password } = transportConfig.credentials;
    const { host, port, fromEmail, fromName } = transportConfig.publicSettings;
    const numPort = Number(port);

    // ── Outbound Queue: Throttle + Daily Quota Check ──────────────────
    const throttleResult = await this.outboundQueue.checkSendAllowed(
      tenantId,
      channelId,
      host,
      to.length + cc.length + bcc.length,
    );
    if (!throttleResult.allowed) {
      throw new Error(throttleResult.reason || 'Send rate limited');
    }

    const transporter = nodemailer.createTransport({
      host,
      port: numPort,
      secure: numPort === 465,
      auth: { user, pass: password },
    });

    // 2. PARSE HTML & PROCESS CID INLINE IMAGES
    // Using cheerio for synchronous DOM manipulation
    // We MUST use for...of for asynchronous operations to avoid unhandled promises
    const $ = cheerio.load(htmlBody);
    const imagesToProcess = $('img').toArray();
    const inlineAttachments: any[] = [];

    for (const [index, el] of imagesToProcess.entries()) {
      const src = $(el).attr('src');
      if (src && src.includes('s3')) {
        // Matches any S3/storage URL
        const cid = `inline-${index}-${Date.now()}@crmsaudi.dev`;
        $(el).attr('src', `cid:${cid}`);

        try {
          // Streaming download from S3 straight into Nodemailer Attachment
          // This avoids the fatal RAM Exhaustion OOM Trap
          const response = await axios({
            method: 'get',
            url: src,
            responseType: 'stream',
          });

          inlineAttachments.push({
            cid,
            filename: `image-${index}.jpg`, // Optional, email clients rely more on CID
            content: response.data,
            contentType: response.headers['content-type'],
          });
        } catch (downloadErr: unknown) {
          const errorMessage =
            downloadErr instanceof Error
              ? downloadErr.message
              : String(downloadErr);
          this.logger.warn(
            `Failed to download inline image from ${src}: ${errorMessage}`,
          );
          // Fallback: If we couldn't download it, we leave the S3 URL to avoid breaking the email entirely
          $(el).attr('src', src);
        }
      }
    }

    // ── Append Email Signature + Signature Fence ───────────────────────
    const signature = await this.emailSignatureService.getSignature(
      tenantId,
      agentId,
      channelId,
    );
    const signatureHtml = signature?.htmlContent || '';
    const signatureFenceHtml =
      this.emailSignatureService.wrapWithSignatureFence(
        signatureHtml,
        conversationId,
      );
    // Append signature + fence to the bottom of the email body
    if ($('body').length) {
      $('body').append(signatureFenceHtml);
    } else {
      $.root().append(signatureFenceHtml);
    }

    const finalHtml = $.html();

    // Setup standardized standard attachments via streams as well
    const formattedAttachments: any[] = [];
    for (const attachment of standardAttachments) {
      try {
        const response = await axios({
          method: 'get',
          url: attachment.url,
          responseType: 'stream',
        });
        formattedAttachments.push({
          filename: attachment.filename,
          content: response.data,
          contentType: attachment.contentType,
        });
      } catch {
        this.logger.error(`Failed to download attachment ${attachment.url}`);
        throw new Error(
          `Could not fetch attachment ${attachment.filename} for email dispatch`,
        );
      }
    }

    const allAttachments = [...formattedAttachments, ...inlineAttachments];

    // 3. Persist placeholder to MessageRepository
    // We do this first so we have the Message ID
    const snippet =
      finalHtml
        .replace(/<[^>]*>?/gm, '')
        .substring(0, 200)
        .trim() || '(No content)';

    let messageRecord;
    try {
      messageRecord = await this.messageRepo.create({
        tenantId,
        conversationId,
        senderId: agentId,
        senderName: senderContext.name,
        senderAvatarUrl: senderContext.avatarUrl ?? undefined,
        senderType: 'agent',
        direction: 'outbound',
        source: 'crm_api',
        messageType: 'text',
        content: snippet,
        status: 'sending',
        metadata: {
          sender: {
            id: agentId,
            name: senderContext.name,
            avatarUrl: senderContext.avatarUrl ?? null,
            type: 'agent',
          },
          source: 'crm_api',
        },
      });
    } catch (dbErr) {
      throw new Error(`Failed to create message record: ${dbErr}`);
    }

    // 4. Send Email via NodeMailer
    let info;
    const fromAddress = fromName ? `"${fromName}" <${fromEmail}>` : fromEmail;
    try {
      info = await transporter.sendMail({
        from: fromAddress,
        to,
        cc,
        bcc,
        subject,
        html: `<html><head><meta charset="utf-8"></head><body>${finalHtml}</body></html>`,
        text: snippet,
        attachments: allAttachments,
        inReplyTo: inReplyTo || undefined,
        references: references.length ? references.join(' ') : undefined,
        headers: {
          // Layer 1: Custom CRM Headers for Thread Correlation (Section 5.4)
          'X-CRM-Thread-ID': conversationId,
          'X-CRM-Tenant-ID': tenantId,
          'X-CRM-Message-Id': messageRecord.id,
        },
      });
    } catch (err) {
      this.logger.error(`Nodemailer failed to send email: ${err}`);
      await this.messageRepo.updateStatus(messageRecord.id, 'failed');
      throw err;
    }

    const externalId = info.messageId || `<${ulid()}@crm.local>`;

    // 5. Update Status + Record Send for Quota Tracking
    await this.messageRepo.updateStatus(messageRecord.id, 'sent', externalId);
    await this.conversationRepo.updateLastMessage(
      conversationId,
      snippet,
      new Date(),
      'agent',
    );

    // Record successful send for daily quota counter
    await this.outboundQueue.recordSend(
      tenantId,
      channelId,
      to.length + cc.length + bcc.length,
    );

    // 6. Save Email Full Content & Metadata
    await this.emailContentModel.create({
      tenantId,
      messageId: messageRecord.id,
      contactIds: [], // Would normally extract from all recipients
      subject,
      htmlBody: finalHtml,
      textBody: snippet,
      attachments: standardAttachments, // store metadata of standard attachments only
    });

    await this.emailMetadataModel.create({
      tenantId,
      mailboxId: channelId,
      messageId: messageRecord.id,
      emailMessageId: externalId,
      inReplyTo,
      references,
      from: fromAddress,
      to,
      cc,
      bcc,
      deliveryStatus: 'unknown',
    });

    // 7. Emit real-time socket event
    this.eventEmitter.emit('omni.message.sent', {
      tenantId,
      conversationId,
      senderId: agentId,
      senderName: senderContext.name,
      senderAvatarUrl: senderContext.avatarUrl ?? null,
      senderType: 'agent',
      messageType: 'text',
      content: snippet, // For UI preview
      messageId: messageRecord.id,
      externalMessageId: externalId,
      status: 'sent',
      timestamp: new Date().toISOString(),
      source: 'crm_api',
      transport: 'http',
    });

    return {
      ok: true,
      messageId: messageRecord.id,
      externalMessageId: externalId,
    };
  }
}
