import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { Model } from 'mongoose';
import { ImportProgress } from './types';

/**
 * Encapsulates progress tracking for an import job:
 *   1. Updates BullMQ job.updateProgress() for Bull Board / polling
 *   2. Updates MongoDB import_job document for persistent history
 *
 * Used by BaseImportProcessor — modules don't need to interact with this directly.
 */
export class ImportProgressTracker {
  private readonly logger = new Logger(ImportProgressTracker.name);

  constructor(
    private readonly importJobModel: Model<any>,
    private readonly bullJobId: string,
  ) {}

  /**
   * Report progress after processing a batch.
   * Caps at 99% — 100% is only set after the report is finalized.
   */
  async report(
    job: Job,
    processed: number,
    estimatedTotal?: number,
  ): Promise<void> {
    const total =
      estimatedTotal && estimatedTotal > 0 ? estimatedTotal : undefined;
    const pct = total
      ? Math.min(99, Math.floor((processed / total) * 100))
      : null;

    const progress: ImportProgress = {
      processed,
      total: total ?? null,
      pct,
    };

    await job.updateProgress(progress);
    await this.updateImportJob({ progress });
  }

  /**
   * Mark the job as 100% complete.
   */
  async complete(job: Job, total: number): Promise<void> {
    const progress: ImportProgress = { processed: total, total, pct: 100 };
    await job.updateProgress(progress);
  }

  /**
   * Update a field on the MongoDB import job record.
   * Best-effort — a failure here should not crash the import.
   */
  async updateImportJob(update: Record<string, any>): Promise<void> {
    try {
      await this.importJobModel.updateOne(
        { bullJobId: this.bullJobId },
        { $set: update },
      );
    } catch (err) {
      this.logger.warn(
        `Failed to update import history (bullJobId=${this.bullJobId}): ${(err as Error).message}`,
      );
    }
  }
}
