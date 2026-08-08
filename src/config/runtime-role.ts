export type RuntimeRole =
  | 'api'
  | 'worker'
  | 'omni'
  | 'email-worker'
  | 'campaign'
  | 'all-in-one';

export function getRuntimeRole(): RuntimeRole {
  const runtime = process.env.APP_RUNTIME;
  if (runtime === 'api') return 'api';
  if (runtime === 'worker') return 'worker';
  if (runtime === 'omni') return 'omni';
  if (runtime === 'email-worker') return 'email-worker';
  if (runtime === 'campaign') return 'campaign';
  // When APP_RUNTIME is not set, this process runs in all-in-one mode:
  // it serves HTTP AND consumes all BullMQ queues in one container.
  return 'all-in-one';
}

/**
 * True when this process should register the general `worker` BullMQ
 * processors (contact import/export, social posts, automations, etc.).
 *
 * Returns true for: `worker` (scaled) and `all-in-one`.
 *
 * Note this no longer covers campaign dispatch/send — see
 * {@link isCampaignRuntime}.
 */
export function isWorkerRuntime(): boolean {
  const role = getRuntimeRole();
  return role === 'worker' || role === 'all-in-one';
}

/**
 * True when this process should register the campaign BullMQ processors
 * (dispatch, send, and the scheduler).
 *
 * Returns true for: `campaign` (scaled) and `all-in-one`.
 *
 * Split out of {@link isWorkerRuntime} because a campaign is the only workload
 * here whose size is chosen by a user rather than by traffic: one 500K-contact
 * send materialises ~5.000 send jobs, and while the generic worker pool is
 * draining them at `CAMPAIGN_SEND_CONCURRENCY`, every contact import and CSV
 * export queued behind them waits. Batch work sharing a pool with batch work is
 * fine right up until one batch is three orders of magnitude larger than the
 * rest.
 *
 * ⚠️ Operational note for scaled deployments: a `worker` replica no longer
 * consumes CAMPAIGN_DISPATCH_QUEUE or CAMPAIGN_SEND_QUEUE. An environment that
 * splits by APP_RUNTIME must run at least one `campaign` replica, or campaigns
 * enqueue successfully and are never sent — no error on either side. See
 * docker-compose.scaled.yml. `all-in-one` is unaffected.
 */
export function isCampaignRuntime(): boolean {
  const role = getRuntimeRole();
  return role === 'campaign' || role === 'all-in-one';
}

/**
 * True when this process should register omni-channel BullMQ processors.
 *
 * Returns true for: `omni` (scaled) and `all-in-one`.
 */
export function isOmniRuntime(): boolean {
  const role = getRuntimeRole();
  return role === 'omni' || role === 'all-in-one';
}

/**
 * True when this process should register email BullMQ processors.
 *
 * Returns true for: `email-worker` (scaled) and `all-in-one`.
 */
export function isEmailWorkerRuntime(): boolean {
  const role = getRuntimeRole();
  return role === 'email-worker' || role === 'all-in-one';
}

/**
 * True if this process should consume BullMQ jobs (any worker type or
 * all-in-one). Use for generic "does this process run processors?" checks.
 */
export function isAnyWorkerRuntime(): boolean {
  const role = getRuntimeRole();
  return ['worker', 'omni', 'email-worker', 'campaign', 'all-in-one'].includes(
    role,
  );
}

/**
 * True only when running as a dedicated API-only process (scaled mode).
 * In this mode, no BullMQ processors are registered.
 */
export function isApiOnlyRuntime(): boolean {
  return getRuntimeRole() === 'api';
}

/**
 * True when running in a DEDICATED worker process (scaled deployment)
 * that does NOT serve HTTP / Socket.IO.
 *
 * Use this in OmniGateway and similar Socket.IO code to decide whether to
 * publish events via Redis (dedicated worker → yes) or broadcast directly
 * (all-in-one or API → no, broadcast directly via local Socket.IO).
 *
 * In all-in-one mode this returns **false** because the same process has
 * both Socket.IO and BullMQ processors, so events can be handled locally.
 */
export function isDedicatedWorkerProcess(): boolean {
  return ['worker', 'omni', 'email-worker', 'campaign'].includes(
    getRuntimeRole(),
  );
}
