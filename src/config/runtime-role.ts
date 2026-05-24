export type RuntimeRole = 'api' | 'worker' | 'omni' | 'email-worker';

export function getRuntimeRole(): RuntimeRole {
  const runtime = process.env.APP_RUNTIME;
  if (runtime === 'worker') return 'worker';
  if (runtime === 'omni') return 'omni';
  if (runtime === 'email-worker') return 'email-worker';
  return 'api';
}

export function isWorkerRuntime(): boolean {
  return getRuntimeRole() === 'worker';
}

export function isOmniRuntime(): boolean {
  return getRuntimeRole() === 'omni';
}

export function isEmailWorkerRuntime(): boolean {
  return getRuntimeRole() === 'email-worker';
}

/** True if this process should consume BullMQ jobs (any worker type) */
export function isAnyWorkerRuntime(): boolean {
  return ['worker', 'omni', 'email-worker'].includes(getRuntimeRole());
}
