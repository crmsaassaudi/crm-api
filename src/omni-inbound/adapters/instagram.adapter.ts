import { Injectable, Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import axios from 'axios';
import { ChannelAdapter } from './channel-adapter.interface';
import { OmniPayload, ChannelType, MessageType } from '../domain/omni-payload';
import { OmniReactionPayload } from '../domain/omni-reaction-payload';
import {
  OutboundMedia,
  MediaSendResult,
} from '../../omni-outbound/types/outbound-media.type';

/** Graph API version — shared with Facebook. */
const IG_GRAPH_VERSION = 'v19.0';

/**
 * Strip access tokens and secrets from Graph API error responses
 * before logging to prevent credential leakage.
 */
function sanitizeIgError(value: any): any {
  if (value == null || typeof value !== 'object') return value;
  const clone: Record<string, any> = Array.isArray(value) ? [] : {};
  for (const [k, v] of Object.entries(value)) {
    if (/token|secret|access|password/i.test(k)) {
      clone[k] = '[REDACTED]';
    } else {
      clone[k] = sanitizeIgError(v);
    }
  }
  return clone;
}

/**
 * Instagram Messaging API webhook → OmniPayload adapter.
 *
 * Instagram uses the same Messenger Platform as Facebook but with
 * IG-scoped user IDs (IGSID) and slightly different webhook structure.
 *
 * Reference: https://developers.facebook.com/docs/instagram-api/guides/messaging
 *
 * Incoming shape (after unwrapping entry[].messaging[]):
 * {
 *   sender:    { id: '<IGSID>' },
 *   recipient: { id: '<IG_BUSINESS_ACCOUNT_ID>' },
 *   timestamp: 1234567890,
 *   message?: {
 *     mid: '<MSG_ID>',
 *     text?: 'Hello!',
 *     is_echo?: boolean,
 *     is_deleted?: boolean,
 *     attachments?: [{ type: 'image'|'video'|'story_mention'|'share'|'reel', payload: { url } }],
 *     reply_to?: { mid: '<REPLY_TO_MSG_ID>' },
 *   }
 * }
 *
 * Instagram-specific attachment types:
 * - story_mention: Customer mentioned your business in their story
 * - share: Customer shared a post/reel to your DM
 * - reel: Customer shared a specific reel
 *
 * Limitations (as of Graph API v19.0):
 * - Outbound: Only text and images are supported (no documents, audio, video)
 * - 24-hour customer reply window applies (same as Messenger)
 * - Reactions: handled by normalizeReaction() (unified reaction pipeline)
 */
@Injectable()
export class InstagramAdapter implements ChannelAdapter {
  readonly channelType: ChannelType = 'instagram';
  private readonly logger = new Logger(InstagramAdapter.name);

  /**
   * Transform an Instagram messaging webhook event into a normalised OmniPayload.
   *
   * @param rawPayload  A single entry from `entry[].messaging[]`
   * @param tenantId    The resolved tenant ID
   * @param channelId   The internal Channel document ID
   * @param channelConfig  The Channel document (credentials, config, account)
   */
  normalize(
    rawPayload: any,
    tenantId: string,
    channelId: string,
    channelConfig?: any,
  ): OmniPayload | null {
    // ── Skip non-message events ──────────────────────────────────
    // Instagram sends delivery receipts, read receipts, reactions via
    // the same webhook URL. Reactions are handled by normalizeReaction().
    if (
      rawPayload.delivery ||
      rawPayload.read ||
      rawPayload.reaction ||
      rawPayload.referral ||
      !rawPayload.message
    ) {
      return null;
    }

    // ── Skip echo messages ────────────────────────────────────────
    // Instagram echoes outbound messages back to the webhook with is_echo=true.
    // OutboundService already persists these, so processing them would create duplicates.
    if (rawPayload.message?.is_echo) {
      this.logger.debug(
        `Skipping Instagram echo message mid=${rawPayload.message?.mid}`,
      );
      return null;
    }

    // ── Skip deleted messages ─────────────────────────────────────
    if (rawPayload.message?.is_deleted) {
      this.logger.debug(
        `Skipping deleted Instagram message mid=${rawPayload.message?.mid}`,
      );
      return null;
    }

    // Instagram uses the same sender/recipient structure as Facebook
    const igBusinessId = rawPayload.recipient?.id;
    const consumerId = rawPayload.sender?.id;
    const messageType = this.resolveMessageType(rawPayload.message);
    const mediaUrl = this.extractMediaUrl(rawPayload.message);

    return {
      tenantId,
      channelId,
      channelAccount: igBusinessId,
      channelType: this.channelType,
      senderId: consumerId,
      senderType: 'customer',
      messageType,
      content: rawPayload.message?.text ?? '',
      mediaUrl: mediaUrl ?? undefined,
      metadata: {
        mid: rawPayload.message?.mid,
        replyTo: rawPayload.message?.reply_to,
        // Carry the channel's access token for media download
        // (Instagram uses Page Access Token for IG messaging API)
        accessToken: channelConfig?.credentials?.accessToken,
        // Track story mentions for UI rendering
        isStoryMention: this.isStoryMention(rawPayload.message),
        isShare: this.isShare(rawPayload.message),
        bot: this.resolveBotConfig(channelConfig),
      },
      externalMessageId: rawPayload.message?.mid ?? '',
      externalConversationId: `${consumerId}_${igBusinessId}`,
      timestamp: new Date(rawPayload.timestamp),
      providerTimestamp: new Date(rawPayload.timestamp),
    };
  }

  /**
   * Verify the X-Hub-Signature-256 HMAC signature on incoming webhooks.
   *
   * Instagram uses the same HMAC-SHA256 mechanism as Facebook Messenger.
   * The signature is computed using the shared Facebook App Secret.
   *
   * @see https://developers.facebook.com/docs/graph-api/webhooks/getting-started#verification-requests
   */
  validateWebhook(
    headers: Record<string, string>,
    body: any,
    rawBody?: Buffer,
  ): boolean {
    const signature = headers['x-hub-signature-256'];
    if (!signature) {
      this.logger.warn('Instagram webhook missing X-Hub-Signature-256 header');
      return false;
    }

    const appSecret =
      process.env.FACEBOOK_APP_SECRET || process.env.META_APP_SECRET;
    if (!appSecret) {
      this.logger.error(
        'FACEBOOK_APP_SECRET is not configured — cannot verify Instagram webhook signature',
      );
      return false;
    }

    if (!rawBody) {
      this.logger.error(
        'Instagram webhook missing rawBody — refusing to validate against re-serialized payload',
      );
      return false;
    }

    const expectedSignature =
      'sha256=' + createHmac('sha256', appSecret).update(rawBody).digest('hex');

    try {
      return timingSafeEqual(
        Buffer.from(signature),
        Buffer.from(expectedSignature),
      );
    } catch {
      return false;
    }
  }

  /**
   * Send a text message via Instagram Messaging API.
   *
   * Instagram DMs use the same Send API as Facebook Messenger,
   * but authenticated with the linked Facebook Page Access Token.
   *
   * @param recipientId   The IG-scoped user ID (IGSID)
   * @param content       Message text
   * @param messageType   'text'
   * @param channelConfig { credentials: { accessToken }, account: igBusinessAccountId }
   *
   * @see https://developers.facebook.com/docs/instagram-api/guides/messaging#sending-messages
   */
  async send(
    recipientId: string,
    content: string,
    messageType: string,
    channelConfig: any,
  ): Promise<any> {
    const accessToken = channelConfig?.credentials?.accessToken;
    if (!accessToken) {
      throw new Error('Instagram adapter lacks access token to send message');
    }

    const payload = {
      recipient: { id: recipientId },
      messaging_type: 'RESPONSE',
      message: { text: content },
    };

    try {
      const response = await axios.post(
        `https://graph.facebook.com/${IG_GRAPH_VERSION}/me/messages`,
        payload,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
          timeout: 10_000,
        },
      );

      const messageId = response.data?.message_id;
      this.logger.log(
        `Instagram text sent to ${recipientId}: messageId=${messageId}`,
      );
      return { message_id: messageId };
    } catch (err: any) {
      const errorData = sanitizeIgError(err?.response?.data ?? err.message);
      this.logger.error(
        `Failed to send Instagram text: ${JSON.stringify(errorData)}`,
      );
      throw new Error(
        `Failed to send Instagram message: ${JSON.stringify(errorData)}`,
      );
    }
  }

  /**
   * Send a media message via Instagram Messaging API.
   *
   * Instagram DMs only support image attachments (no documents, audio, video).
   * For unsupported types, we return a failure instead of silently dropping.
   *
   * @see https://developers.facebook.com/docs/instagram-api/guides/messaging#send-images
   */
  async sendMedia(
    recipientId: string,
    media: OutboundMedia,
    channelConfig: any,
  ): Promise<MediaSendResult> {
    const accessToken = channelConfig?.credentials?.accessToken;
    if (!accessToken) {
      return { success: false, error: 'Instagram adapter lacks access token' };
    }

    // Instagram only supports image attachments in DMs
    if (!media.mimeType?.startsWith('image/')) {
      return {
        success: false,
        error: `Instagram does not support ${media.mimeType} media in DMs. Only images are allowed.`,
      };
    }

    // Instagram requires a publicly accessible URL for media attachments.
    // The OutboundService should have already resolved a presigned S3 URL.
    const mediaUrl = media.storageKey
      ? undefined // Will be resolved by OutboundService
      : undefined;

    if (!mediaUrl && !media.storageKey) {
      // Fallback: if we have a buffer, we can't directly upload to Instagram.
      // Instagram requires a public URL, not a direct buffer upload.
      return {
        success: false,
        error:
          'Instagram requires a public URL for media. Buffer-only upload is not supported.',
      };
    }

    // This path will be used when OutboundService provides a presigned URL
    const payload = {
      recipient: { id: recipientId },
      messaging_type: 'RESPONSE',
      message: {
        attachment: {
          type: 'image',
          payload: { url: mediaUrl, is_reusable: false },
        },
      },
    };

    try {
      const response = await axios.post(
        `https://graph.facebook.com/${IG_GRAPH_VERSION}/me/messages`,
        payload,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
          timeout: 15_000,
        },
      );

      const messageId = response.data?.message_id;
      this.logger.log(
        `Instagram image sent to ${recipientId}: messageId=${messageId}`,
      );
      return { success: true, externalMessageId: messageId };
    } catch (err: any) {
      const errorData = sanitizeIgError(err?.response?.data ?? err.message);
      this.logger.error(
        `Failed to send Instagram image: ${JSON.stringify(errorData)}`,
      );
      return {
        success: false,
        error: `Instagram image send failed: ${JSON.stringify(errorData)}`,
      };
    }
  }

  /**
   * Fetch the Instagram user's profile for identity enrichment.
   *
   * @param igsid       IG-scoped user ID
   * @param accessToken Page Access Token linked to the IG Business Account
   *
   * @see https://developers.facebook.com/docs/instagram-api/reference/ig-user
   */
  async enrichProfile(
    igsid: string,
    accessToken: string,
  ): Promise<{ name?: string; avatarUrl?: string }> {
    try {
      const response = await axios.get(
        `https://graph.facebook.com/${IG_GRAPH_VERSION}/${igsid}`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
          params: { fields: 'name,profile_pic' },
          timeout: 5_000,
        },
      );

      const name = response.data?.name;
      const avatarUrl = response.data?.profile_pic;

      this.logger.log(
        `Enriched Instagram profile for IGSID ${igsid}: name=${name ?? '∅'}, avatar=${avatarUrl ? '✓' : '✗'}`,
      );

      return { name, avatarUrl };
    } catch (err: any) {
      const errorData = sanitizeIgError(err?.response?.data ?? err.message);
      this.logger.warn(
        `Failed to enrich Instagram profile for IGSID ${igsid}: ${JSON.stringify(errorData)}`,
      );
      return {};
    }
  }

  // ─── Private helpers ─────────────────────────────────────────────

  private resolveMessageType(message: any): MessageType {
    if (!message) return 'text';
    if (message.text && !message.attachments) return 'text';

    const attachment = message.attachments?.[0];
    if (!attachment) return 'text';

    switch (attachment.type) {
      case 'image':
        return 'image';
      case 'video':
        return 'video';
      case 'audio':
        return 'audio';
      case 'story_mention':
        return 'image'; // Story mentions include a story media URL
      case 'share':
        return 'text'; // Shared posts are rendered as text with metadata
      case 'reel':
        return 'video';
      default:
        return 'file';
    }
  }

  private extractMediaUrl(message: any): string | null {
    const attachment = message?.attachments?.[0];
    return attachment?.payload?.url ?? null;
  }

  private isStoryMention(message: any): boolean {
    return message?.attachments?.[0]?.type === 'story_mention';
  }

  private isShare(message: any): boolean {
    const type = message?.attachments?.[0]?.type;
    return type === 'share' || type === 'reel';
  }

  private resolveBotConfig(
    channelConfig?: any,
  ): Record<string, any> | undefined {
    const config = channelConfig?.config ?? {};
    return config.bot ?? config.typebot ?? undefined;
  }

  /**
   * Extract a reaction event from an Instagram webhook payload.
   * Same format as Facebook (shared Meta platform).
   */
  normalizeReaction(
    rawPayload: any,
    tenantId: string,
    channelId: string,
  ): OmniReactionPayload | null {
    if (!rawPayload.reaction) return null;

    const r = rawPayload.reaction;
    return {
      tenantId,
      channelId,
      channelType: 'instagram',
      externalMessageId: r.mid,
      senderId: rawPayload.sender?.id,
      senderType: 'customer',
      emoji: r.emoji || '',
      action: r.action === 'unreact' ? 'unreact' : 'react',
      timestamp: new Date(rawPayload.timestamp),
    };
  }
}
