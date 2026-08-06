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
import { validateForPlatform } from '../files/config/platform-limits.config';
import { mimeToMessageType } from '../common/utils/mime.util';
import { UsersService } from '../users/users.service';
import { enforceReplyWindow } from './reply-window';
import { DeliveryCommandService } from './delivery-command.service';
import {
  SsrfBlockedError,
  SsrfGuardService,
} from '../common/http/ssrf-guard.service';
import { AttachmentSecurityService } from '../channels/services/attachment-security.service';

/**
 * Ceiling for media relayed from a bot flow. Matches the attachment gateway's
 * own 25 MB limit so the two cannot disagree about what is too large.
 */
const MAX_BOT_MEDIA_BYTES = 25 * 1024 * 1024;

/** Wall-clock budget for fetching bot media, redirects included. */
const BOT_MEDIA_TIMEOUT_MS = 15_000;

/** Extension for each type `ImageProcessingService` can re-encode to. */
const MIME_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/**
 * Align a filename's extension with the type actually being sent.
 *
 * Outbound images are re-encoded, so `photo.webp` can leave as JPEG bytes. Several
 * provider APIs infer the attachment type from the extension, and the omni UI uses
 * it for the download name, so a stale extension shows up as a rejected send or a
 * file that will not open. Unknown types and already-correct names pass through.
 */
export function renameForMime(fileName: string, mimeType: string): string {
  const extension = MIME_EXTENSIONS[mimeType.toLowerCase()];
  if (!extension) return fileName;

  const dot = fileName.lastIndexOf('.');
  // No extension, or a leading-dot name like ".gitignore" — leave it alone rather
  // than inventing a basename.
  if (dot <= 0) return fileName;

  const current = fileName.slice(dot + 1).toLowerCase();
  if (current === extension) return fileName;
  // Treat .jpeg/.jfif as already correct for JPEG; renaming them is churn.
  if (extension === 'jpg' && (current === 'jpeg' || current === 'jfif')) {
    return fileName;
  }

  return `${fileName.slice(0, dot)}.${extension}`;
}

/**
 * OutboundMediaHandler
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
    private readonly filesService: FilesService,
    private readonly imageProcessingService: ImageProcessingService,
    private readonly usersService: UsersService,
    private readonly deliveryCommands: DeliveryCommandService,
    private readonly ssrfGuard: SsrfGuardService,
    private readonly attachmentSecurity: AttachmentSecurityService,
  ) {}

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
    if (!media.fileId) {
      throw new Error(
        'Agent media delivery requires a durable fileId. Upload the file before sending.',
      );
    }

    // 1. Resolve conversation + channel
    const { conversation } = await this.resolveConversationAndChannel(
      tenantId,
      conversationId,
    );
    this.enforceReplyWindow(conversation);

    // 2. Resolve media buffer
    const mediaBuffer = await this.resolveMediaBuffer(media, agentId);

    // 3. Compress for platform if image. This runs BEFORE validation on purpose:
    //    compression targets the platform's own cap (Zalo's preset targets exactly
    //    the 1 MB the table allows), so validating the uploaded bytes first would
    //    reject any ordinary phone photo on the strictest channels — the ones
    //    compression exists to serve.
    const channelKey = conversation.channelType.toLowerCase() as ChannelType;
    const compressed = await this.compressMediaForPlatform(
      mediaBuffer,
      media.mimeType,
      channelKey,
    );
    const sendBuffer = compressed.buffer;

    // Re-encoding changes the format, so everything downstream must describe the
    // bytes being sent rather than the bytes uploaded.
    const effectiveMimeType = compressed.mimeType;

    // 4. Validate what will actually go out
    this.validatePlatformLimits(
      channelKey,
      effectiveMimeType,
      sendBuffer.length,
    );

    // 5. Determine message type
    const messageType = mimeToMessageType(effectiveMimeType);

    // 6. Persist message
    const message = await this.persistAgentMediaMessage({
      tenantId,
      conversationId,
      agentId,
      senderContext,
      media,
      sendBuffer,
      effectiveMimeType,
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

    // 7. Persist a durable delivery command. The worker owns provider dispatch.
    const queued = await this.deliveryCommands.enqueue({
      tenantId,
      conversationId,
      messageId: message.id,
      agentId,
      content: caption || `[${messageType}] ${media.fileName}`,
      messageType,
      kind: 'media',
      payload: {
        media: {
          fileId: media.fileId,
          mimeType: media.mimeType,
          fileName: media.fileName,
          size: media.size,
          url: media.url,
          storageKey: media.storageKey,
        },
        caption,
      },
      source,
      transport,
      idempotencyKey,
      clientMessageId,
    });

    return {
      ok: true,
      queued: true,
      deferred: queued.deferred,
      commandId: queued.commandId,
      messageId: message.id,
      status: 'sending',
      idempotencyKey,
      clientMessageId,
      senderId: agentId,
      senderName: senderContext.name,
      source,
    };
  }

  async dispatchDeliveryCommand(params: {
    tenantId: string;
    conversationId: string;
    agentId: string;
    messageId: string;
    payload: {
      media: OutboundMedia;
      caption?: string;
    };
  }): Promise<{ message_id?: string; id?: string }> {
    const { tenantId, conversationId, agentId, messageId, payload } = params;
    const media = { ...payload.media };
    if (!media.fileId) {
      throw new Error('Durable media command is missing fileId');
    }

    const { conversation, channel } = await this.resolveConversationAndChannel(
      tenantId,
      conversationId,
    );
    this.enforceReplyWindow(conversation);

    const mediaBuffer = await this.resolveMediaBuffer(media, agentId);
    const channelKey = conversation.channelType.toLowerCase() as ChannelType;
    const compressed = await this.compressMediaForPlatform(
      mediaBuffer,
      media.mimeType,
      channelKey,
    );
    const sendBuffer = compressed.buffer;
    const effectiveMimeType = compressed.mimeType;
    this.validatePlatformLimits(
      channelKey,
      effectiveMimeType,
      sendBuffer.length,
    );

    const externalId = await this.dispatchAgentMedia({
      conversation,
      channel,
      media,
      sendBuffer,
      effectiveMimeType,
      caption: payload.caption ?? '',
      channelKey,
      messageId,
    });
    return { message_id: externalId };
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
      media.storageKey = media.storageKey ?? file.path;
      media.size = buffer.length;
      return buffer;
    }

    if (media.buffer) {
      return media.buffer;
    }

    throw new Error('Either fileId or buffer must be provided');
  }

  /**
   * Validate media against per-channel platform limits.
   *
   * Delegates to `validateForPlatform`, which owns the same table this used to
   * read directly. The hand-rolled version it replaces classified media as
   * `isImage ? image : file`, so:
   *
   *   - video and audio were checked against the DOCUMENT cap — a 40 MB video
   *     passed WhatsApp's 64 MB file limit while its real video limit is 16 MB;
   *   - a `null` entry (Zalo accepts no video or audio at all) fell through to
   *     the file limit and then `if (limit && …)` skipped the check entirely;
   *   - the allowed mime list was never consulted.
   *
   * Each of those surfaced as an opaque provider-side failure after the message
   * had already been persisted as `sending`, instead of a message saying which
   * limit was hit.
   */
  private validatePlatformLimits(
    channelKey: ChannelType,
    mimeType: string,
    bufferLength: number,
  ): void {
    const error = validateForPlatform(channelKey, mimeType, bufferLength);
    if (error) throw new Error(error);
  }

  /**
   * Compress an image for the target platform.
   *
   * Returns the effective mime type alongside the buffer: `compressForPlatform`
   * re-encodes to JPEG, so a WebP upload leaves here as JPEG. Dropping that (as
   * this method used to) left the persisted message, the emitted event and the
   * adapter payload all declaring the ORIGINAL type over re-encoded bytes.
   *
   * Non-image and non-processable types pass through with their type unchanged.
   */
  private async compressMediaForPlatform(
    mediaBuffer: Buffer,
    mimeType: string,
    channelKey: ChannelType,
  ): Promise<{ buffer: Buffer; mimeType: string }> {
    if (
      !mimeType.startsWith('image/') ||
      !this.imageProcessingService.isProcessableImage(mimeType)
    ) {
      return { buffer: mediaBuffer, mimeType };
    }

    try {
      const compressed = await this.imageProcessingService.compressForPlatform(
        mediaBuffer,
        channelKey,
      );
      this.logger.log(
        `Compressed image for ${channelKey}: ${(mediaBuffer.length / 1024).toFixed(0)}KB → ${(compressed.buffer.length / 1024).toFixed(0)}KB`,
      );
      return { buffer: compressed.buffer, mimeType: compressed.mimeType };
    } catch (err) {
      // Fall back to the original bytes AND the original type — reporting the
      // compressed type after a failed compression would be a lie.
      this.logger.warn(
        `Platform compression failed, using original: ${(err as Error).message}`,
      );
      return { buffer: mediaBuffer, mimeType };
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
    /** Type of the bytes actually sent — may differ from `media.mimeType`. */
    effectiveMimeType: string;
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
          fileName: renameForMime(opts.media.fileName, opts.effectiveMimeType),
          // The sent bytes, not the uploaded ones: the omni UI renders history
          // straight from this metadata, and a WebP label over JPEG bytes shows
          // a broken thumbnail.
          mimeType: opts.effectiveMimeType,
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
    conversation: any;
    channel: any;
    media: OutboundMedia;
    sendBuffer: Buffer;
    /** Type of the bytes actually sent — may differ from `media.mimeType`. */
    effectiveMimeType: string;
    caption: string;
    channelKey: ChannelType;
    messageId: string;
  }): Promise<string | undefined> {
    try {
      const adapter = this.adapters.get(ctx.channelKey);
      if (!adapter) {
        throw new Error(`No outbound adapter registered for ${ctx.channelKey}`);
      }
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
          // Describe the re-encoded bytes. Providers validate the declared type
          // against the body (and some infer it from the extension), so a stale
          // `image/webp` on a JPEG body is rejected by the stricter APIs.
          mimeType: ctx.effectiveMimeType,
          fileName: renameForMime(ctx.media.fileName, ctx.effectiveMimeType),
          caption: ctx.caption,
          url: resolvedUrl,
        };
        const result = await adapter.sendMedia(
          ctx.conversation.customer.externalId,
          sendMediaPayload,
          {
            credentials: ctx.channel.credentials,
            account: ctx.channel.account,
            messageId: ctx.messageId,
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
          ctx.messageId,
          ctx.channel,
        );
      }
      return externalId;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to send media via provider: ${errorMessage}`);
      throw error;
    }
  }

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
      // A blocked URL is a rejected URL. Falling back to "send the link as
      // text" would hand the customer the very address the guard refused, so
      // the message is dropped instead.
      if (downloadResult.blocked) {
        this.logger.error(
          `Bot media rejected for conversation ${conversationId}: ${downloadResult.error}`,
        );
        return { ok: false, blocked: true, reason: downloadResult.error };
      }

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

  /**
   * Download the media a bot flow asked us to relay.
   *
   * `mediaUrl` is attacker-reachable input: it arrives on the bot callback, and
   * a flow author picks it. A bare `fetch` here was a full-read SSRF — crm-api
   * would fetch any address reachable from the worker (cloud metadata, the VPC,
   * localhost) and then deliver the response body to the customer as media,
   * which is an exfiltration channel, not just a blind request. So the fetch
   * goes through the same guard webhook actions use: scheme + private-range
   * checks, DNS pinning, and every redirect hop re-validated.
   *
   * `blocked` is distinct from a plain failure. A failed download falls back to
   * sending the link as text; a BLOCKED one must not, because echoing
   * `http://169.254.169.254/…` into the conversation just moves the payload.
   */
  private async downloadBotMedia(
    mediaUrl: string,
    rawMimeType?: string,
  ): Promise<{
    success: boolean;
    buffer?: Buffer;
    mimeType?: string;
    fileName?: string;
    error?: string;
    blocked?: boolean;
  }> {
    try {
      const response = await this.ssrfGuard.safeFetch(mediaUrl, {
        signal: AbortSignal.timeout(BOT_MEDIA_TIMEOUT_MS),
      });
      if (!response.ok)
        throw new Error(`Failed to download: ${response.status}`);

      const buffer = await this.readCapped(response, MAX_BOT_MEDIA_BYTES);
      const mimeType =
        rawMimeType ??
        response.headers.get('content-type')?.split(';')[0].trim() ??
        'application/octet-stream';
      let fileName = 'bot-media';
      try {
        const pathname = new URL(mediaUrl).pathname;
        const basename = pathname.split('/').pop();
        if (basename?.includes('.')) fileName = basename;
      } catch {
        /* ignore */
      }

      // Bot media reaches a real customer over a real channel, so it gets the
      // same extension/size policy as an agent upload. This path used to skip
      // the gateway entirely.
      const scan = this.attachmentSecurity.scanAttachment(
        fileName,
        buffer.length,
      );
      if (!scan.safe) {
        return { success: false, blocked: true, error: scan.reason };
      }

      return { success: true, buffer, mimeType, fileName };
    } catch (error: any) {
      if (error instanceof SsrfBlockedError) {
        this.logger.error(
          `[BOT-MEDIA] SSRF-blocked bot media URL: ${error.message}`,
        );
        return { success: false, blocked: true, error: error.message };
      }
      return { success: false, error: error.message };
    }
  }

  /**
   * Read a response body with a hard byte ceiling.
   *
   * `arrayBuffer()` buffers whatever the peer sends, so a hostile or merely
   * huge URL could exhaust the worker's heap. Content-Length is checked first
   * as a cheap reject, but it is a claim, not a promise — the streamed read
   * enforces the same cap on the bytes that actually arrive.
   */
  private async readCapped(response: Response, maxBytes: number) {
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel().catch(() => {});
      throw new Error(
        `Media exceeds the maximum of ${maxBytes} bytes (declared ${declared})`,
      );
    }

    if (!response.body) return Buffer.alloc(0);

    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > maxBytes) {
          throw new Error(`Media exceeds the maximum of ${maxBytes} bytes`);
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    return Buffer.concat(chunks, total);
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

  // Private Helpers

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

  // Shared Helpers

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
    enforceReplyWindow(conversation);
  }
}
