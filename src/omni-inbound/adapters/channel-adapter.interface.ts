import { OmniPayload, ChannelType } from '../domain/omni-payload';
import { OmniReactionPayload } from '../domain/omni-reaction-payload';
import { DeliveryReceipt } from '../domain/delivery-receipt';
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
   * Transform a raw provider webhook event into normalised messages.
   *
   * Returns every message the event carries — providers batch, and WhatsApp in
   * particular puts an array under one `changes[].value`. Returning a single
   * payload silently discarded everything after the first.
   *
   * An empty array means the event carries no messages (delivery receipts, read
   * receipts, reactions). Throws if the payload is malformed or unsupported.
   */
  normalize(
    rawPayload: any,
    tenantId: string,
    channelId: string,
    channelConfig?: any,
  ): OmniPayload[];

  /**
   * Extract delivery/read receipts for messages we sent.
   * Optional — only implemented by providers that report them.
   */
  normalizeDeliveryReceipts?(rawPayload: any): DeliveryReceipt[];

  /**
   * Extract a reaction event from a raw provider webhook body.
   * Returns `null` if the payload is not a reaction event.
   * Optional — only implemented by adapters whose platform supports reactions.
   */
  normalizeReaction?(
    rawPayload: any,
    tenantId: string,
    channelId: string,
    channelConfig?: any,
  ): OmniReactionPayload | null;

  /**
   * Validate the authenticity of an incoming webhook request
   * (e.g. verify HMAC signature for FB, or token for Zalo).
   * Returns `true` if the request is legit.
   */
  validateWebhook(
    headers: Record<string, string>,
    body: any,
    rawBody?: Buffer,
    /**
     * Per-channel signing secret, when the connected channel carries one.
     *
     * Providers differ: Meta signs every Page's webhook with a single app
     * secret, but each Zalo OA and each TikTok app has its own. With only an
     * env-level secret, exactly one tenant could verify those channels — the
     * rest were rejected at the door. Falls back to the env secret when the
     * channel does not define one.
     */
    secret?: string,
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

  /**
   * Send an interactive message with buttons or list options.
   * Optional — only supported by WhatsApp (interactive messages) and
   * Facebook Messenger (quick replies).
   *
   * @param recipientId    The provider's user ID
   * @param body           Message body text
   * @param buttons        Array of button options with id and title
   * @param channelConfig  Credentials/config for this specific channel
   */
  sendInteractive?(
    recipientId: string,
    body: string,
    buttons: Array<{ id: string; title: string }>,
    channelConfig: any,
  ): Promise<any>;

  /**
   * Send a carousel message with swipeable cards.
   * Optional — only supported by Livechat (native carousel) and
   * Facebook Messenger (generic template).
   *
   * @param recipientId    The provider's user ID
   * @param content        Optional body text above the carousel
   * @param cards          Array of carousel card objects
   * @param channelConfig  Credentials/config for this specific channel
   */
  sendCarousel?(
    recipientId: string,
    content: string | undefined,
    cards: Array<{
      title?: string;
      subtitle?: string;
      imageUrl?: string;
      defaultAction?: { type: string; url?: string };
      buttons?: Array<{
        id?: string;
        title: string;
        type?: string;
        url?: string;
      }>;
    }>,
    channelConfig: any,
  ): Promise<any>;
}

/** DI token for the adapter map */
export const CHANNEL_ADAPTERS = Symbol('CHANNEL_ADAPTERS');
