import { createHash } from 'crypto';
import { OmniPayload } from './omni-payload';

/**
 * The stable identity of an inbound message, used everywhere it has to be
 * deduplicated: the routing queue, the Redis claim keys and the
 * `platformMessageId` unique index.
 *
 * Prefer the provider's own id. When there is none, derive a fingerprint from
 * the message's content and origin — never fall back to an empty string, which
 * would make every id-less message in a tenant look like the same message.
 */
export function buildMessageDedupId(payload: OmniPayload): string {
  const externalMessageId = payload.externalMessageId?.trim();
  if (externalMessageId) {
    return externalMessageId;
  }

  const fingerprint = [
    payload.tenantId,
    payload.channelType,
    payload.channelId,
    payload.channelAccount,
    payload.externalConversationId,
    payload.senderId,
    toFingerprintDate(payload.providerTimestamp ?? payload.timestamp),
    payload.messageType,
    payload.content ?? '',
    payload.mediaUrl ?? '',
  ].join('|');

  return `synthetic:${createHash('sha256').update(fingerprint).digest('hex')}`;
}

function toFingerprintDate(value: Date | string | undefined): string {
  if (!value) {
    return '';
  }

  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}
