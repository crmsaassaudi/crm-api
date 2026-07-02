import { Injectable, Logger, Inject } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { MessageRepository } from '../omni-inbound/repositories/message.repository';
import { ConversationRepository } from '../omni-inbound/repositories/conversation.repository';
import { ChannelRepository } from '../channels/infrastructure/persistence/document/repositories/channel.repository';
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
import { UsersService } from '../users/users.service';
import { ReplyWindowExpiredException } from './exceptions/reply-window-expired.exception';
import { ConfigType } from '@nestjs/config';
import replyWindowConfig from './config/reply-window.config';

/**
 * T-040: OutboundMediaHandler
 *
 * Extracted from OutboundService to isolate media-specific concerns:
 * - File resolution (S3 download, buffer handling)
 * - Platform limit validation
 * - Image compression per channel
 * - Bot media download + fallback
 *
 * Reduces OutboundService by ~700 lines.
 */
@Injectable()
export class OutboundMediaHandler {
  private readonly logger = new Logger(OutboundMediaHandler.name);

  constructor(
    private readonly messageRepo: MessageRepository,
    private readonly conversationRepo: ConversationRepository,
    private readonly channelRepo: ChannelRepository,
    private readonly eventEmitter: EventEmitter2,
    @Inject(CHANNEL_ADAPTERS)
    private readonly adapters: Map<ChannelType, ChannelAdapter>,
    @Inject(replyWindowConfig.KEY)
    private readonly replyWindowCfg: ConfigType<typeof replyWindowConfig>,
    private readonly filesService: FilesService,
    private readonly imageProcessingService: ImageProcessingService,
    private readonly usersService: UsersService,
  ) {}

  // ── Agent Media ─────────────────────────────────────────────────────────

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
      source = 'agent_ui',
      transport = 'http',
      idempotencyKey,
      clientMessageId,
    } = params;

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
      const file = await this.filesService.findById(media.fileId);
      if (!file) throw new Error(`File ${media.fileId} not found`);
      if (!this.filesService.checkAccess(file, agentId, 'AGENT')) {
        throw new Error('No access to this file');
      }
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
    const messageType = mimeToMessageType(media.mimeType);

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
        const sendMediaPayload: OutboundMedia = {
          ...media,
          buffer: sendBuffer,
          size: sendBuffer.length,
          caption,
        };
        const result = await adapter.sendMedia(
          conversation.customer.externalId,
          sendMediaPayload,
          {
            credentials: channel.credentials,
            account: channel.account,
            messageId: message.id,
          },
        );
        externalId = result.externalMessageId;
        if (!result.success) {
          throw new Error(result.error || 'Adapter sendMedia failed');
        }
      } else if (adapter) {
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
          {
            credentials: channel.credentials,
            account: channel.account,
            messageId: message.id,
          },
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

  // ── Bot Media ───────────────────────────────────────────────────────────

  async sendBotMedia(
    params: {
      tenantId: string;
      conversationId: string;
      mediaUrl: string;
      mediaType: string;
      mimeType?: string;
      caption?: string;
      idempotencyKey?: string;
    },
    /** Callback for text fallback when media download fails */
    sendBotTextFallback: (params: {
      tenantId: string;
      conversationId: string;
      content: string;
      messageType?: string;
      idempotencyKey?: string;
    }) => Promise<any>,
  ): Promise<any> {
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

      const contentType = response.headers.get('content-type');
      if (contentType && mimeType === 'application/octet-stream') {
        mimeType = contentType.split(';')[0].trim();
      }

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
      return sendBotTextFallback({
        tenantId,
        conversationId,
        content: caption ? `${caption}\n${mediaUrl}` : mediaUrl,
        messageType: 'text',
        idempotencyKey,
      });
    }

    const resolvedMessageType = mimeToMessageType(mimeType);

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
      providerTimestamp: new Date(),
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
          {
            credentials: channel.credentials,
            account: channel.account,
            messageId: message.id,
          },
        );
        externalId = result.externalMessageId;
        if (!result.success) {
          throw new Error(result.error || 'Adapter sendMedia failed');
        }
      } else if (adapter) {
        const fallbackContent = caption
          ? `${caption}\n${mediaUrl}`
          : `📎 ${fileName}\n${mediaUrl}`;
        const resp = await adapter.send(
          conversation.customer.externalId,
          fallbackContent,
          'text',
          {
            credentials: channel.credentials,
            account: channel.account,
            messageId: message.id,
          },
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

  // ── Shared Helpers ──────────────────────────────────────────────────────

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

  private enforceReplyWindow(conversation: {
    channelType: string;
    lastCustomerMessageAt?: Date | null;
  }): void {
    const cfg = this.replyWindowCfg as any;
    const channelKey = conversation.channelType.toLowerCase() as ChannelType;
    const channelCfg = cfg?.channels?.[channelKey];

    if (!channelCfg?.enabled || !channelCfg?.windowHours) return;
    if (!conversation.lastCustomerMessageAt) return;

    const windowMs = channelCfg.windowHours * 3600_000;
    const now = Date.now();
    const lastMsg = new Date(conversation.lastCustomerMessageAt).getTime();

    if (now - lastMsg > windowMs) {
      throw new ReplyWindowExpiredException(
        channelKey,
        channelCfg.windowHours,
        new Date(lastMsg),
        new Date(lastMsg + windowMs),
      );
    }
  }
}
