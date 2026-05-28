import { JobsOptions } from 'bullmq';

/**
 * Shared default job options for every BullMQ producer.
 *
 * - `attempts: 3` + exponential backoff means transient infra failures retry
 *   on their own without hammering Redis.
 * - `removeOnComplete` / `removeOnFail` caps the per-queue ZSET so Redis
 *   memory stays bounded. We keep recently completed jobs (1 day) for audit
 *   and failed jobs (7 days) for DLQ + RCA workflows.
 *
 * Producers should spread this and override only the keys they actually need.
 */
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: {
    type: 'exponential',
    delay: 5_000,
  },
  removeOnComplete: { count: 500, age: 60 * 60 * 24 },
  removeOnFail: { count: 1_000, age: 60 * 60 * 24 * 7 },
};

/** Job options for inbound webhook / high-throughput producers. */
export const HIGH_THROUGHPUT_JOB_OPTIONS: JobsOptions = {
  ...DEFAULT_JOB_OPTIONS,
  attempts: 5,
  removeOnComplete: { count: 1_000, age: 60 * 60 * 6 },
};

/** Job options for low-priority/background jobs that can tolerate retries. */
export const BACKGROUND_JOB_OPTIONS: JobsOptions = {
  ...DEFAULT_JOB_OPTIONS,
  attempts: 5,
  backoff: { type: 'exponential', delay: 10_000 },
};
