import { ChannelType } from './omni-payload';

/**
 * What a channel can actually do.
 *
 * This exists because `KNOWN_CHANNELS` was a list of intentions. It advertised
 * `voice`, `sms` and `shopee`, none of which have any implementation, and
 * `tiktok`, whose `send()` threw unconditionally while its webhook could not
 * resolve an account and so dropped every inbound message. Both appeared in the
 * channel picker, the reports filter and the distribution chart: a tenant could
 * select a channel that silently discarded its customers.
 *
 * One declaration, read by everything — the picker, routing, reports, the reply
 * composer. A channel is only offered where its capabilities say it works, so a
 * half-built channel can be merged without being sold.
 */
export interface ChannelCapabilities {
  /** Inbound messages reach a conversation. */
  receive: boolean;
  /** Agents can send a free-form reply. */
  send: boolean;
  /** Media (image/file/video) can be sent outbound. */
  sendMedia: boolean;
  /**
   * Pre-approved templates can be sent outside the reply window — the only way
   * to re-open a WhatsApp conversation after 24 hours.
   */
  sendTemplate: boolean;
  /** The provider reports delivered/read receipts. */
  deliveryReceipts: boolean;
  /** A CSAT survey link can be delivered to the customer on this channel. */
  csat: boolean;
  /**
   * Hours an agent may reply free-form after the customer's last message.
   * 0 means no limit — a channel we host ourselves.
   */
  replyWindowHours: number;
}

const DEFAULTS: ChannelCapabilities = {
  receive: true,
  send: true,
  sendMedia: true,
  sendTemplate: false,
  deliveryReceipts: false,
  csat: true,
  replyWindowHours: 24,
};

/**
 * Every channel the platform actually serves.
 *
 * To add one: implement the adapter, then add it here. A channel absent from
 * this map is rejected at the webhook and hidden from the UI — which is the
 * intended behaviour for a channel that is not finished.
 */
export const CHANNEL_CAPABILITIES: Readonly<
  Record<string, ChannelCapabilities>
> = Object.freeze({
  facebook: { ...DEFAULTS, deliveryReceipts: true },
  instagram: { ...DEFAULTS, deliveryReceipts: true },
  whatsapp: {
    ...DEFAULTS,
    sendTemplate: true,
    deliveryReceipts: true,
  },
  zalo: { ...DEFAULTS },
  telegram: { ...DEFAULTS, replyWindowHours: 0 },
  tiktok: { ...DEFAULTS },
  // Ours end to end: no provider window, and the survey is rendered by the
  // widget rather than sent as a message.
  livechat: { ...DEFAULTS, replyWindowHours: 0 },
  email: {
    ...DEFAULTS,
    // Email threads never expire, and an email client shows no read receipt we
    // can trust.
    replyWindowHours: 0,
    deliveryReceipts: false,
  },
});

/** The channels this platform serves, for UI pickers and validation. */
export const SUPPORTED_CHANNELS = Object.keys(
  CHANNEL_CAPABILITIES,
) as ChannelType[];

export function isSupportedChannel(type: string): boolean {
  return Object.prototype.hasOwnProperty.call(CHANNEL_CAPABILITIES, type);
}

/**
 * Capabilities for a channel.
 *
 * Throws rather than returning a permissive default: an unknown channel reaching
 * this function means something is routing traffic the platform has not
 * implemented, and answering "yes, you can send" would turn that into a silently
 * dropped customer message.
 */
export function channelCapabilities(type: string): ChannelCapabilities {
  const capabilities = CHANNEL_CAPABILITIES[type];
  if (!capabilities) {
    throw new Error(`Unsupported channel type: ${type}`);
  }
  return capabilities;
}

export function canChannel(
  type: string,
  capability: keyof ChannelCapabilities,
): boolean {
  return Boolean(CHANNEL_CAPABILITIES[type]?.[capability]);
}
