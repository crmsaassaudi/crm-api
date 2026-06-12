import { OmniPayload, ChannelType } from '../domain/omni-payload';
import {
  OutboundMedia,
  MediaSendResult,
} from '../../omni-outbound/types/outbound-media.type';

/**
 * Strategy interface for channel-specific data normalization.
 *
 * Each messaging provider (Facebook, Zalo, WhatsApp, …) ships a different
 * webhook format.  An adapter's job is to translate that raw JSON into
 * our standard `OmniPayload` so the rest of the pipeline never has to
 * care which provider the data came from.
 */
export interface ChannelAdapter {
  /** Which channel type this adapter handles */
  readonly channelType: ChannelType;

  /**
   * Transform a raw provider webhook body into a normalised `OmniPayload`.
   * Returns `null` for non-message events (delivery receipts, read receipts,
   * reactions, etc.) that should be silently skipped.
   * Throws if the payload is malformed or unsupported.
   */
  normalize(
    rawPayload: any,
    tenantId: string,
    channelId: string,
    channelConfig?: any,
  ): OmniPayload | null;

  /**
   * Validate the authenticity of an incoming webhook request
   * (e.g. verify HMAC signature for FB, or token for Zalo).
   * Returns `true` if the request is legit.
   */
  validateWebhook(
    headers: Record<string, string>,
    body: any,
    rawBody?: Buffer,
  ): boolean;

  /**
   * Send an outbound text message to the provider's API.
   *
   * @param recipientId  The provider's user ID (e.g. PSID, Zalo User ID)
   * @param content      Message text or media payload
   * @param messageType  Type of message (text, image, etc.)
   * @param channelConfig Credentials/config for this specific channel
   */
  send(
    recipientId: string,
    content: string,
    messageType: string,
    channelConfig: any,
  ): Promise<any>;

  /**
   * Send an outbound media message to the provider's API.
   * Optional — if not implemented, OutboundService will fall back to
   * sending a text message with a download link.
   *
   * @param recipientId   The provider's user ID
   * @param media         Media buffer + metadata
   * @param channelConfig Credentials/config for this specific channel
   */
  sendMedia?(
    recipientId: string,
    media: OutboundMedia,
    channelConfig: any,
  ): Promise<MediaSendResult>;

  /**
   * Fetch the sender's profile from the provider for identity enrichment.
   * Optional — only implemented by adapters whose platform provides a profile API.
   *
   * @param externalId   The provider's user ID (PSID, IGSID, etc.)
   * @param accessToken  Channel-specific access token
   */
  enrichProfile?(
    externalId: string,
    accessToken: string,
  ): Promise<{ name?: string; avatarUrl?: string; phone?: string }>;

  /**
   * Send a pre-approved template message to the provider's API.
   * Optional — only supported by WhatsApp (template messages bypass the reply window).
   *
   * @param recipientId    The provider's user ID
   * @param templateName   Template name as registered on the provider
   * @param languageCode   Language code (e.g. 'vi', 'en_US')
   * @param components     Template parameter values (header, body, buttons)
   * @param channelConfig  Credentials/config for this specific channel
   */
  sendTemplate?(
    recipientId: string,
    templateName: string,
    languageCode: string,
    components: any[],
    channelConfig: any,
  ): Promise<any>;
}

/** DI token for the adapter map */
export const CHANNEL_ADAPTERS = Symbol('CHANNEL_ADAPTERS');
