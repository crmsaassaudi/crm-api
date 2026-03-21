import { OmniPayload, ChannelType } from '../domain/omni-payload';

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
   * Throws if the payload is malformed or unsupported.
   */
  normalize(rawPayload: any, tenantId: string, channelId: string): OmniPayload;

  /**
   * Validate the authenticity of an incoming webhook request
   * (e.g. verify HMAC signature for FB, or token for Zalo).
   * Returns `true` if the request is legit.
   */
  validateWebhook(headers: Record<string, string>, body: any): boolean;

  /**
   * Send an outbound message to the provider's API.
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
}

/** DI token for the adapter map */
export const CHANNEL_ADAPTERS = Symbol('CHANNEL_ADAPTERS');
