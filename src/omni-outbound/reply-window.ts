import { channelCapabilities } from '../omni-inbound/domain/channel-capabilities';
import { ReplyWindowExpiredException } from './exceptions/reply-window-expired.exception';

export interface ReplyWindowStatus {
  isOpen: boolean;
  channelType: string;
  lastCustomerMessageAt: string | null;
  expiresAt: string | null;
  remainingMs: number;
  windowHours: number;
}

/**
 * The platform reply window: how long after the customer's last message an agent
 * may still send a free-form reply.
 *
 * One implementation, reading `CHANNEL_CAPABILITIES`. There were two, over a
 * config object whose shape they disagreed about: `OutboundService` read
 * `cfg[channel]` (a number, which is what the factory produced) while
 * `OutboundMediaHandler` read `cfg.channels[channel].windowHours`, which was
 * always `undefined` — so its guard returned early every time and **media
 * replies bypassed the window entirely**, going to the provider to be rejected
 * with an error the agent could not act on.
 *
 * The values are platform-imposed constants (Meta's 24 hours is not ours to
 * tune), so they belong with the channel's other capabilities rather than in
 * per-environment configuration where two deployments can disagree about what
 * Facebook allows.
 */
export function getReplyWindowStatus(conversation: {
  channelType: string;
  lastCustomerMessageAt?: Date | null;
}): ReplyWindowStatus {
  const channelType = conversation.channelType.toLowerCase();
  const { replyWindowHours } = channelCapabilities(channelType);
  const lastCustomerMessageAt = conversation.lastCustomerMessageAt
    ? new Date(conversation.lastCustomerMessageAt)
    : null;

  // 0 hours means the channel imposes no window — one we host ourselves.
  if (replyWindowHours === 0) {
    return {
      isOpen: true,
      channelType,
      lastCustomerMessageAt: lastCustomerMessageAt?.toISOString() ?? null,
      expiresAt: null,
      remainingMs: Infinity,
      windowHours: 0,
    };
  }

  // No inbound message yet: on a windowed channel there is nothing to reply to,
  // so the window is closed rather than open-by-default.
  if (!lastCustomerMessageAt) {
    return {
      isOpen: false,
      channelType,
      lastCustomerMessageAt: null,
      expiresAt: null,
      remainingMs: 0,
      windowHours: replyWindowHours,
    };
  }

  const expiresAt = new Date(
    lastCustomerMessageAt.getTime() + replyWindowHours * 3_600_000,
  );
  const remainingMs = expiresAt.getTime() - Date.now();

  return {
    isOpen: remainingMs > 0,
    channelType,
    lastCustomerMessageAt: lastCustomerMessageAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    remainingMs: Math.max(remainingMs, 0),
    windowHours: replyWindowHours,
  };
}

/**
 * Throw when the window has closed. Called before persisting or sending any
 * free-form message; template sends deliberately skip it, since re-opening a
 * closed window is what templates are for.
 */
export function enforceReplyWindow(conversation: {
  channelType: string;
  lastCustomerMessageAt?: Date | null;
}): void {
  const status = getReplyWindowStatus(conversation);
  if (status.isOpen || status.windowHours === 0) return;

  throw new ReplyWindowExpiredException(
    status.channelType,
    status.windowHours,
    conversation.lastCustomerMessageAt
      ? new Date(conversation.lastCustomerMessageAt)
      : new Date(0),
    status.expiresAt ? new Date(status.expiresAt) : new Date(),
  );
}
