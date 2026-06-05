import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { Model } from 'mongoose';
import Redis from 'ioredis';
import { ExportProgress } from './types';

/** Redis key namespace for cancel flags. */
const cancelKey = (jobId: string) => `export:cancel:${jobId}`;
/** Cancel flags live long enough to outlast any reasonable export. */
const CANCEL_TTL_SECONDS = 6 * 60 * 60;

/**
 * Progress + cancellation for an export job:
 *   1. BullMQ job.updateProgress() for Bull Board / polling
 *   2. export_jobs document for persistent history
 *   3. Redis cancel flag the worker polls each batch
 *
 * Used by BaseExportProcessor; the API layer uses the static cancel helper.
 */
export class ExportProgressTracker {
  private readonly logger = new Logger(ExportProgressTracker.name);

  constructor(
    private readonly exportJobModel: Model<any>,
    private readonly redis: Redis,
    private readonly bullJobId: string,
  ) {}

  /** Caps at 99% — 100% is only set on completion. total=null → pct=null. */
  async report(
    job: Job,
    processed: number,
    estimatedTotal: number | null,
  ): Promise<void> {
    const total = estimatedTotal && estimatedTotal > 0 ? estimatedTotal : null;
    const pct = total
      ? Math.min(99, Math.floor((processed / total) * 100))
      : null;
    const progress: ExportProgress = { processed, total, pct };
    await job.updateProgress(progress);
    await this.update({ progress });
  }

  async complete(job: Job, total: number): Promise<void> {
    const progress: ExportProgress = { processed: total, total, pct: 100 };
    await job.updateProgress(progress);
  }

  /** True if the user requested cancellation (Redis flag set by the API). */
  async isCancelled(): Promise<boolean> {
    try {
      return (await this.redis.exists(cancelKey(this.bullJobId))) === 1;
    } catch {
      return false; // never let a Redis blip kill a healthy export
    }
  }

  /** Best-effort patch of the export_jobs document. */
  async update(patch: Record<string, any>): Promise<void> {
    try {
      await this.exportJobModel.updateOne(
        { bullJobId: this.bullJobId },
        { $set: patch },
      );
    } catch (err) {
      this.logger.warn(
        `Failed to update export history (bullJobId=${this.bullJobId}): ${(err as Error).message}`,
      );
    }
  }

  // ── Static cancel helpers (used by the API process) ──

  static async requestCancel(redis: Redis, jobId: string): Promise<void> {
    await redis.set(cancelKey(jobId), '1', 'EX', CANCEL_TTL_SECONDS);
  }

  static async clearCancel(redis: Redis, jobId: string): Promise<void> {
    await redis.del(cancelKey(jobId));
  }
}
