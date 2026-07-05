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
    const { conversation, channel } = await this.resolveConversationAndChannel(
      tenantId,
      conversationId,
    );
    this.enforceReplyWindow(conversation);

    // 2. Resolve media buffer
    const mediaBuffer = await this.resolveMediaBuffer(media, agentId);

    // 3. Validate against platform limits
    const channelKey = conversation.channelType.toLowerCase() as ChannelType;
    this.validatePlatformLimits(channelKey, media.mimeType, mediaBuffer.length);

    // 4. Compress for platform if image
    const sendBuffer = await this.compressMediaForPlatform(
      mediaBuffer,
      media.mimeType,
      channelKey,
    );

    // 5. Determine message type
    const messageType = mimeToMessageType(media.mimeType);

    // 6. Persist message
    const message = await this.persistAgentMediaMessage({
      tenantId,
      conversationId,
      agentId,
      senderContext,
      media,
      sendBuffer,
      caption,
      source,
      transport,
      messageType,
      idempotencyKey,
      clientMessageId,
    });

    await this.conversationRepo.updateLastMessage(
      conversationId,
      caption || `📎 ${media.fileName}`,
      new Date(),
      'agent',
    );

    // 7. Send via adapter
    return this.dispatchAgentMedia({
      tenantId,
      conversationId,
      agentId,
      senderContext,
      conversation,
      channel,
      media,
      sendBuffer,
      caption,
      channelKey,
      messageType,
      message,
      idempotencyKey,
      clientMessageId,
      source,
      transport,
    });
  }

  /**
   * Resolve conversation and its associated channel.
   * Tries channelId first, falls back to channelAccount lookup.
   */
  private async resolveConversationAndChannel(
    tenantId: string,
    conversationId: string,
  ): Promise<{ conversation: any; channel: any }> {
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

    return { conversation, channel };
  }

  /**
   * Resolve the media buffer from either a fileId (S3 download) or an
   * inline buffer. Mutates media fields (mimeType, fileName, size) when
   * resolved from S3.
   */
  private async resolveMediaBuffer(
    media: OutboundMedia,
    agentId: string,
  ): Promise<Buffer> {
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
      const buffer = Buffer.from(await response.arrayBuffer());
      media.mimeType =
        media.mimeType ?? file.mimeType ?? 'application/octet-stream';
      media.fileName = media.fileName ?? file.fileName ?? 'file';
      media.size = buffer.length;
      return buffer;
    }

    if (media.buffer) {
      return media.buffer;
    }

    throw new Error('Either fileId or buffer must be provided');
  }

  /**
   * Validate media file size against per-channel platform limits.
   */
  private validatePlatformLimits(
    channelKey: ChannelType,
    mimeType: string,
    bufferLength: number,
  ): void {
    const platformLimits = PLATFORM_LIMITS[channelKey];
    if (!platformLimits) return;

    const isImage = mimeType.startsWith('image/');
    const limit = isImage ? platformLimits.image : platformLimits.file;
    if (limit && bufferLength > limit.maxBytes) {
      throw new Error(
        `File size ${(bufferLength / (1024 * 1024)).toFixed(1)}MB exceeds ${channelKey} limit of ${(limit.maxBytes / (1024 * 1024)).toFixed(0)}MB`,
      );
    }
  }

  /**
   * Compress image for the target platform. Returns the original buffer
   * for non-image or non-processable types.
   */
  private async compressMediaForPlatform(
    mediaBuffer: Buffer,
    mimeType: string,
    channelKey: ChannelType,
  ): Promise<Buffer> {
    if (
      !mimeType.startsWith('image/') ||
      !this.imageProcessingService.isProcessableImage(mimeType)
    ) {
      return mediaBuffer;
    }

    try {
      const compressed = await this.imageProcessingService.compressForPlatform(
        mediaBuffer,
        channelKey,
      );
      this.logger.log(
        `Compressed image for ${channelKey}: ${(mediaBuffer.length / 1024).toFixed(0)}KB → ${(compressed.buffer.length / 1024).toFixed(0)}KB`,
      );
      return compressed.buffer;
    } catch (err) {
      this.logger.warn(
        `Platform compression failed, using original: ${(err as Error).message}`,
      );
      return mediaBuffer;
    }
  }

  /**
   * Persist the outbound agent media message to the database.
   */
  private async persistAgentMediaMessage(opts: {
    tenantId: string;
    conversationId: string;
    agentId: string;
    senderContext: { name: string; avatarUrl?: string | null };
    media: OutboundMedia;
    sendBuffer: Buffer;
    caption: string;
    source: string;
    transport: string;
    messageType: string;
    idempotencyKey?: string;
    clientMessageId?: string;
  }): Promise<any> {
    return this.messageRepo.create({
      tenantId: opts.tenantId,
      conversationId: opts.conversationId,
      senderId: opts.agentId,
      senderName: opts.senderContext.name,
      senderAvatarUrl: opts.senderContext.avatarUrl ?? undefined,
      senderType: 'agent',
      direction: 'outbound',
      source: opts.source,
      messageType: opts.messageType,
      content: opts.caption || `[${opts.messageType}] ${opts.media.fileName}`,
      status: 'sending',
      idempotencyKey: opts.idempotencyKey,
      clientMessageId: opts.clientMessageId,
      metadata: {
        sender: {
          id: opts.agentId,
          name: opts.senderContext.name,
          avatarUrl: opts.senderContext.avatarUrl ?? null,
          type: 'agent',
        },
        source: opts.source,
        transport: opts.transport,
        media: {
          fileName: opts.media.fileName,
          mimeType: opts.media.mimeType,
          size: opts.sendBuffer.length,
          fileId: opts.media.fileId,
        },
      },
    });
  }

  /**
   * Dispatch media to the channel adapter and emit the sent event.
   * Handles adapter selection, fallback, status update, and error recovery.
   */
  private async dispatchAgentMedia(ctx: {
    tenantId: string;
    conversationId: string;
    agentId: string;
    senderContext: { name: string; avatarUrl?: string | null };
    conversation: any;
    channel: any;
    media: OutboundMedia;
    sendBuffer: Buffer;
    caption: string;
    channelKey: ChannelType;
    messageType: string;
    message: any;
    idempotencyKey?: string;
    clientMessageId?: string;
    source: string;
    transport: string;
  }): Promise<any> {
    try {
      const adapter = this.adapters.get(ctx.channelKey);
      let externalId: string | undefined;

      if (adapter?.sendMedia) {
        const resolvedUrl = await this.resolvePublicUrl(
          ctx.media,
          ctx.channelKey,
        );
        const sendMediaPayload: OutboundMedia = {
          ...ctx.media,
          buffer: ctx.sendBuffer,
          size: ctx.sendBuffer.length,
          caption: ctx.caption,
          url: resolvedUrl,
        };
        const result = await adapter.sendMedia(
          ctx.conversation.customer.externalId,
          sendMediaPayload,
          {
            credentials: ctx.channel.credentials,
            account: ctx.channel.account,
            messageId: ctx.message.id,
          },
        );
        externalId = result.externalMessageId;
        if (!result.success) {
          throw new Error(result.error ?? 'Adapter sendMedia failed');
        }
      } else if (adapter) {
        externalId = await this.sendViaFallbackAdapter(
          adapter,
          ctx.conversation,
          ctx.media,
          ctx.caption,
          ctx.message.id,
          ctx.channel,
        );
      }

      await this.messageRepo.updateStatus(ctx.message.id, 'sent', externalId);

      this.eventEmitter.emit('omni.message.sent', {
        tenantId: ctx.tenantId,
        conversationId: ctx.conversationId,
        senderId: ctx.agentId,
        senderName: ctx.senderContext.name,
        senderAvatarUrl: ctx.senderContext.avatarUrl ?? null,
        senderType: 'agent',
        messageType: ctx.messageType,
        content: ctx.caption || `[${ctx.messageType}] ${ctx.media.fileName}`,
        messageId: ctx.message.id,
        externalMessageId: externalId,
        status: 'sent',
        idempotencyKey: ctx.idempotencyKey,
        clientMessageId: ctx.clientMessageId,
        timestamp: new Date().toISOString(),
        source: ctx.source,
        transport: ctx.transport,
      });

      return {
        ok: true,
        messageId: ctx.message.id,
        externalMessageId: externalId,
        status: 'sent',
        idempotencyKey: ctx.idempotencyKey,
        clientMessageId: ctx.clientMessageId,
        senderId: ctx.agentId,
        senderName: ctx.senderContext.name,
        source: ctx.source,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to send media via provider: ${errorMessage}`);
      await this.messageRepo.updateStatus(ctx.message.id, 'failed');
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
      afterTimestamp?: number;
    },
    /** Callback for text fallback when media download fails */
    sendBotTextFallback: (params: {
      tenantId: string;
      conversationId: string;
      content: string;
      messageType?: string;
      idempotencyKey?: string;
      afterTimestamp?: number;
    }) => Promise<any>,
  ): Promise<any> {
    const {
      tenantId,
      conversationId,
      mediaUrl,
      caption = '',
      idempotencyKey,
      afterTimestamp,
    } = params;

    if (idempotencyKey) {
      const existing = await this.messageRepo.findByIdempotencyKey(
        tenantId,
        idempotencyKey,
      );
      if (existing?.status && existing.status !== 'failed') {
        return { ok: true, messageId: existing.id, reused: true };
      }
    }

    const conversation = await this.conversationRepo.findById(conversationId);
    if (!conversation)
      throw new Error(`Conversation ${conversationId} not found`);

    const channel = await this.resolveChannelForOutbound(
      tenantId,
      conversation,
    );
    this.enforceReplyWindow(conversation);

    // Download media from bot URL
    const downloadResult = await this.downloadBotMedia(
      mediaUrl,
      params.mimeType,
    );
    if (!downloadResult.success) {
      this.logger.warn(
        `Bot media download failed: ${downloadResult.error}. Falling back to link.`,
      );
      return sendBotTextFallback({
        tenantId,
        conversationId,
        content: caption ? `${caption}\n${mediaUrl}` : mediaUrl,
        messageType: 'text',
        idempotencyKey,
        afterTimestamp,
      });
    }

    const botTimestamp = afterTimestamp
      ? new Date(Math.max(Date.now(), afterTimestamp + 1))
      : new Date();

    return this.persistAndDispatchMedia({
      tenantId,
      conversationId,
      conversation,
      channel,
      mediaBuffer: downloadResult.buffer!,
      mimeType: downloadResult.mimeType!,
      fileName: downloadResult.fileName!,
      caption,
      idempotencyKey,
      botTimestamp,
    });
  }

  private async resolveChannelForOutbound(
    tenantId: string,
    conversation: any,
  ): Promise<any> {
    let channel = await this.channelRepo.findByIdWithCredentials(
      tenantId,
      conversation.channelId.toString(),
    );
    if (!channel && conversation.channelAccount) {
      channel = await this.channelRepo.findByAccountWithCredentials(
        tenantId,
        conversation.channelType,
        conversation.channelAccount,
      );
    }
    if (!channel)
      throw new Error(`Channel for conversation ${conversation.id} not found`);
    return channel;
  }

  private async downloadBotMedia(
    mediaUrl: string,
    rawMimeType?: string,
  ): Promise<{
    success: boolean;
    buffer?: Buffer;
    mimeType?: string;
    fileName?: string;
    error?: string;
  }> {
    try {
      const response = await fetch(mediaUrl, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok)
        throw new Error(`Failed to download: ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      const mimeType =
        rawMimeType ??
        response.headers.get('content-type')?.split(';')[0].trim() ??
        'application/octet-stream';
      let fileName = 'bot-media';
      try {
        const pathname = new URL(mediaUrl).pathname;
        const basename = pathname.split('/').pop();
        if (basename && basename.includes('.')) fileName = basename;
      } catch {
        /* ignore */
      }
      return { success: true, buffer, mimeType, fileName };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  private async persistAndDispatchMedia(params: any): Promise<any> {
    const {
      tenantId,
      conversationId,
      conversation,
      channel,
      mediaBuffer,
      mimeType,
      fileName,
      caption,
      idempotencyKey,
      botTimestamp,
    } = params;
    const messageType = mimeToMessageType(mimeType);

    const message = await this.messageRepo.create({
      tenantId,
      conversationId,
      senderId: 'bot:typebot',
      senderName: 'Bot',
      senderType: 'bot',
      direction: 'outbound',
      source: 'bot',
      messageType,
      content: caption || `[${messageType}] ${fileName}`,
      status: 'sending',
      idempotencyKey,
      providerTimestamp: botTimestamp,
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
        if (!result.success)
          throw new Error(result.error ?? 'Adapter sendMedia failed');
        externalId = result.externalMessageId;
      } else if (adapter) {
        const adapterResponse = await adapter.send(
          conversation.customer.externalId,
          caption ? `${caption}\n[media]` : `📎 ${fileName}`,
          'text',
          {
            credentials: channel.credentials,
            account: channel.account,
            messageId: message.id,
          },
        );
        externalId = adapterResponse?.message_id ?? adapterResponse?.id;
      }

      await this.messageRepo.updateStatus(message.id, 'sent', externalId);
      this.eventEmitter.emit('omni.message.sent', {
        tenantId,
        conversationId,
        senderId: 'bot:typebot',
        senderName: 'Bot',
        senderType: 'bot',
        direction: 'outbound',
        messageType,
        content: caption || `[${messageType}] ${fileName}`,
        messageId: message.id,
        externalMessageId: externalId,
        status: 'sent',
        idempotencyKey,
        timestamp: new Date().toISOString(),
        source: 'bot',
        transport: 'http',
      });
      return { ok: true, messageId: message.id, status: 'sent' };
    } catch (error: any) {
      this.logger.error(`Failed to send bot media: ${error.message}`);
      await this.messageRepo.updateStatus(message.id, 'failed');
      throw error;
    }
  }

  // ── Private Helpers ─────────────────────────────────────────────────────

  /**
   * Resolve a public URL for channels that require one (Instagram, Zalo).
   * Returns the existing URL if already set, otherwise generates a presigned S3 URL.
   */
  private async resolvePublicUrl(
    media: OutboundMedia,
    channelKey: ChannelType,
  ): Promise<string | undefined> {
    if (media.url) return media.url;
    if (channelKey !== 'instagram' && channelKey !== 'zalo') return undefined;
    if (!media.fileId) return undefined;
    const file = await this.filesService.findById(media.fileId);
    if (!file) return undefined;
    return this.filesService.getPresignedDownloadUrl(file.path, 3600);
  }

  /**
   * Send media via text-only adapter fallback (attach download link in content).
   */
  private async sendViaFallbackAdapter(
    adapter: ChannelAdapter,
    conversation: any,
    media: OutboundMedia,
    caption: string,
    messageId: string,
    channel: any,
  ): Promise<string | undefined> {
    const downloadUrl = media.fileId
      ? await this.filesService.getPresignedDownloadUrl(
          media.storageKey ?? '',
          3600,
        )
      : '';
    const fallbackContent =
      caption || `📎 ${media.fileName}${downloadUrl ? '\n' + downloadUrl : ''}`;
    const adapterResponse = await adapter.send(
      conversation.customer.externalId,
      fallbackContent,
      'text',
      {
        credentials: channel.credentials,
        account: channel.account,
        messageId,
      },
    );
    return adapterResponse?.message_id ?? adapterResponse?.id;
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
        name: (fullName || user.email) ?? 'Agent',
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
