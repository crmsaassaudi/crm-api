export const OMNI_DELIVERY_QUEUE = 'omni-delivery';

/**
 * BullMQ priority for outbound sends — lower number runs first.
 *
 * One queue, three tiers. A person waiting on a reply must never queue behind a
 * broadcast: without a priority the queue is strict FIFO, so a bulk run of any
 * size pushes every agent reply behind it for the run's whole duration.
 */
export const DELIVERY_PRIORITY = {
  /** An agent is typing to a customer who is waiting. */
  agent: 1,
  /** Automated but conversational — the customer is still in the thread. */
  bot: 5,
  /** Broadcasts and campaigns. Throughput matters, latency does not. */
  bulk: 10,
} as const;

export type DeliveryPriorityTier = keyof typeof DELIVERY_PRIORITY;

/**
 * Attempts for a delivery job.
 *
 * Only pre-dispatch failures consume them — the processor rewinds the command
 * to `pending` when, and only when, nothing was sent yet.
 */
export const DELIVERY_MAX_ATTEMPTS = 3;

/**
 * Which tier a send belongs to, from the `source` the caller recorded.
 *
 * Defaults to `agent`: an unrecognised source is far more likely to be a new
 * interactive path than a new bulk one, and mis-tiering a bulk send as urgent
 * is a smaller failure than making a customer wait behind a campaign.
 */
export function deliveryPriorityFor(source: string | undefined): number {
  if (!source) return DELIVERY_PRIORITY.agent;
  if (/campaign|broadcast|bulk|import/i.test(source)) {
    return DELIVERY_PRIORITY.bulk;
  }
  if (/bot|automation|workflow/i.test(source)) return DELIVERY_PRIORITY.bot;
  return DELIVERY_PRIORITY.agent;
}
