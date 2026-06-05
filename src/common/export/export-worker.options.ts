import type { WorkerOptions } from 'bullmq';
import { ExportFormat } from './types';

/**
 * Shared BullMQ worker options for ALL export processors, tuned via env so ops
 * can scale the export pool without code changes:
 *
 *   EXPORT_WORKER_CONCURRENCY  jobs processed in parallel per worker (default 2)
 *   EXPORT_RATE_MAX            max jobs started per window (default 10)
 *   EXPORT_RATE_DURATION_MS    rate-limit window in ms (default 60_000)
 *
 * For a dedicated export pool, run more `APP_RUNTIME=worker` replicas — each
 * registers these processors (see isWorkerRuntime gating).
 */
export const EXPORT_WORKER_OPTIONS: Pick<
  WorkerOptions,
  'concurrency' | 'limiter'
> = {
  concurrency: Number(process.env.EXPORT_WORKER_CONCURRENCY ?? 2),
  limiter: {
    max: Number(process.env.EXPORT_RATE_MAX ?? 10),
    duration: Number(process.env.EXPORT_RATE_DURATION_MS ?? 60_000),
  },
};

/**
 * Default per-format hard row caps. Streaming keeps memory flat regardless of
 * size, so these are generous abuse-guards rather than memory limits. XLSX rolls
 * over to new sheets at the Excel per-sheet limit, so its cap can be high too.
 */
export const DEFAULT_EXPORT_HARD_CAP: Record<ExportFormat, number> = {
  csv: Number(process.env.EXPORT_HARD_CAP_CSV ?? 5_000_000),
  xlsx: Number(process.env.EXPORT_HARD_CAP_XLSX ?? 5_000_000),
};
