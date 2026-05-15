export type RuntimeRole = 'api' | 'worker';

export function getRuntimeRole(): RuntimeRole {
  return process.env.APP_RUNTIME === 'worker' ? 'worker' : 'api';
}

export function isWorkerRuntime(): boolean {
  return getRuntimeRole() === 'worker';
}
