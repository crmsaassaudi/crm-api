import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { readdir, stat, unlink } from 'fs/promises';
import { join } from 'path';
import { RedisLockService } from '../../redis/redis-lock.service';
import { ExportJobSchemaClass, ExportJobDocument } from './export-job.schema';

/** A job stuck 'active' longer than this is assumed dead (worker crashed). */
const STALE_ACTIVE_MS = 60 * 60 * 1000; // 1 hour (> the 10-min lock TTL)
/** Local export files older than this are reaped. */
const LOCAL_FILE_TTL_MS =
  Number(process.env.EXPORT_DOWNLOAD_TTL_SECONDS ?? 24 * 60 * 60) * 1000;

/**
 * Reaps the debris a crashed export worker leaves behind:
 *   1. export_jobs stuck in 'active' past STALE_ACTIVE_MS → marked 'failed'
 *      (the worker's `finally` never ran, so the doc would otherwise hang).
 *   2. Local-mode temp export files older than the file TTL.
 *
 * Cluster-singleton via RedisLockService (mirrors OrphanCleanupCron).
 */
@Injectable()
export class ExportCleanupCron {
  private readonly logger = new Logger(ExportCleanupCron.name);

  constructor(
    @InjectModel(ExportJobSchemaClass.name)
    private readonly exportJobModel: Model<ExportJobDocument>,
    private readonly lockService: RedisLockService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async handleCleanup(): Promise<void> {
    try {
      await this.lockService.acquire(
        'cron:export:cleanup',
        55 * 60 * 1000,
        () => this.run(),
      );
    } catch (err) {
      this.logger.warn(`Export cleanup skipped: ${(err as Error).message}`);
    }
  }

  private async run(): Promise<void> {
    await this.reapStaleJobs();
    await this.reapLocalFiles();
  }

  private async reapStaleJobs(): Promise<void> {
    const cutoff = new Date(Date.now() - STALE_ACTIVE_MS);
    // Platform query: this cron sweeps ALL tenants and has no CLS tenant.
    const res = await this.exportJobModel.updateMany(
      { status: 'active', startedAt: { $lt: cutoff } },
      {
        $set: {
          status: 'failed',
          failedReason:
            'Stale export reaped by cleanup cron (worker likely crashed)',
          completedAt: new Date(),
        },
      },
      { isPlatformQuery: true } as any,
    );
    if (res.modifiedCount) {
      this.logger.warn(
        `Reaped ${res.modifiedCount} stale active export job(s)`,
      );
    }
  }

  private async reapLocalFiles(): Promise<void> {
    const root = join(process.cwd(), 'files', 'exports');
    let moduleDirs: string[];
    try {
      moduleDirs = await readdir(root);
    } catch {
      return; // no exports dir (S3 mode or nothing exported yet)
    }

    const now = Date.now();
    let removed = 0;
    for (const moduleDir of moduleDirs) {
      const dir = join(root, moduleDir);
      let files: string[];
      try {
        files = await readdir(dir);
      } catch {
        continue;
      }
      for (const file of files) {
        const filePath = join(dir, file);
        try {
          const info = await stat(filePath);
          if (info.isFile() && now - info.mtimeMs > LOCAL_FILE_TTL_MS) {
            await unlink(filePath);
            removed++;
          }
        } catch {
          // raced with another reaper / download — ignore
        }
      }
    }
    if (removed) {
      this.logger.log(`Reaped ${removed} expired local export file(s)`);
    }
  }
}
