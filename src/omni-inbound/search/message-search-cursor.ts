import { BadRequestException } from '@nestjs/common';
import { ThreadCursor } from '../repositories/message.repository';

/**
 * Encode a thread position as an opaque cursor.
 *
 * All three components travel, because the sort has all three: provider
 * timestamps arrive in whole seconds, so a burst of messages shares one, and a
 * cursor carrying only the timestamp would skip or repeat every message on the
 * page boundary.
 */
export function encodeMessageSearchCursor(cursor: ThreadCursor): string {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      t: cursor.providerTimestamp.toISOString(),
      s: cursor.sequence,
      i: cursor.id,
    }),
    'utf8',
  ).toString('base64url');
}

/**
 * Decode a cursor, refusing anything malformed.
 *
 * A rejected cursor is a 400 rather than a silent restart from page one:
 * silently restarting makes a paging bug look like duplicate data, which is
 * indistinguishable from a data-integrity problem to whoever reports it.
 */
export function decodeMessageSearchCursor(
  raw: string | undefined,
): ThreadCursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (parsed?.v !== 1) throw new Error('unsupported cursor version');
    const providerTimestamp = new Date(parsed.t);
    if (Number.isNaN(providerTimestamp.getTime())) {
      throw new Error('invalid timestamp');
    }
    if (typeof parsed.i !== 'string' || !parsed.i) {
      throw new Error('invalid id');
    }
    return {
      providerTimestamp,
      sequence: Number.isFinite(parsed.s) ? Number(parsed.s) : 0,
      id: parsed.i,
    };
  } catch {
    throw new BadRequestException('Invalid or stale search cursor');
  }
}
