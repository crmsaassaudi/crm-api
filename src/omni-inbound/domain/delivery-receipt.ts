/**
 * A provider's report on a message we sent.
 *
 * Providers deliver these on the same webhook as inbound messages. Without them
 * an outbound message is stuck at `sent` forever: we know it left, never that it
 * arrived, and the only correction available is the reconciliation cron marking
 * it failed on a timeout.
 */
export interface DeliveryReceipt {
  /** The provider's id for the message, as returned when we sent it. */
  externalMessageId: string;
  status: DeliveryReceiptStatus;
  occurredAt: Date;
  /** Provider error code, for `failed`. */
  errorCode?: string;
  errorMessage?: string;
}

export type DeliveryReceiptStatus = 'delivered' | 'read' | 'failed';

/**
 * Ranking used to ignore receipts that arrive out of order — a `delivered`
 * webhook overtaking the `read` it followed must not walk the status back.
 */
const PROGRESSION: Record<string, number> = {
  pending: 0,
  sending: 1,
  sent: 2,
  delivered: 3,
  read: 4,
};

/** True when `next` is a forward move from `current`. */
export function isStatusProgression(current: string, next: string): boolean {
  // A failure is terminal information and always wins; anything else must move
  // forward through the ladder.
  if (next === 'failed') return current !== 'failed';
  if (current === 'failed') return false;
  return (PROGRESSION[next] ?? -1) > (PROGRESSION[current] ?? -1);
}
