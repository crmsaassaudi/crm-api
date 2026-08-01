/**
 * How many jobs a single worker process handles at once.
 *
 * BullMQ defaults to 1. For the omni pipeline that default is a hard ceiling:
 * an inbound message crosses three queues in series, so one job at a time per
 * stage caps a replica at roughly `1 / per-message latency` messages per
 * second — a few per second — no matter how much CPU the pod has. The work is
 * almost entirely waiting on Mongo and Redis, so raising concurrency converts
 * idle await time into throughput.
 *
 * Per-queue overrides are read from the environment so a deployment can tune a
 * stage without a release.
 */
export function workerConcurrency(envVar: string, fallback: number): number {
  const configured = Number(process.env[envVar]);
  return Number.isInteger(configured) && configured > 0 ? configured : fallback;
}

/**
 * Defaults per stage.
 *
 * Webhook and routing are thin (a Redis claim, one channel lookup, an enqueue)
 * so they take the highest. Conversation-ops is heavier and already serialised
 * per conversation by a Redis lock, so its concurrency only buys parallelism
 * *across* conversations. Delivery is bounded by provider rate limits, not by us.
 */
export const OMNI_CONCURRENCY = {
  webhook: () => workerConcurrency('OMNI_WEBHOOK_CONCURRENCY', 16),
  routing: () => workerConcurrency('OMNI_ROUTING_CONCURRENCY', 16),
  conversationOps: () => workerConcurrency('OMNI_CONV_OPS_CONCURRENCY', 8),
  delivery: () => workerConcurrency('OMNI_DELIVERY_CONCURRENCY', 8),
  bot: () => workerConcurrency('OMNI_BOT_CONCURRENCY', 8),
  media: () => workerConcurrency('OMNI_MEDIA_CONCURRENCY', 4),
  maintenance: () => workerConcurrency('OMNI_MAINTENANCE_CONCURRENCY', 4),
};
