import { Logger } from '@nestjs/common';
import { OnWorkerEvent } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { Connection, Model } from 'mongoose';
import { ClsService } from 'nestjs-cls';
import Redis from 'ioredis';

import { BaseTenantConsumer } from '../../queue/base-tenant.consumer';
import {
  BaseExportJobData,
  ExportCancelledError,
  ExportColumn,
  ExportLimitExceededError,
  ExportModuleConfig,
  ExportResult,
  SecondaryUnavailableError,
} from './types';
import { ExportStorageService } from './export-storage.service';
import { ExportMaskingService, ExportMasker } from './export-masking.service';
import { ExportProgressTracker } from './export-progress.service';
import { createExportWriter } from './format/export-format.factory';
import { RedisLockService } from '../../redis/redis-lock.service';

const LOCK_TTL_MS = 10 * 60 * 1000; // 10 min, heartbeat-renewed by lock service
const COUNT_MAX_TIME_MS = 3_000; // cap the progress-count query
const DOWNLOAD_TTL_SECONDS = Number(
  process.env.EXPORT_DOWNLOAD_TTL_SECONDS ?? 24 * 60 * 60,
);
const READ_PREFERENCE =
  process.env.EXPORT_READ_PREFERENCE ?? 'secondaryPreferred';

/** Mongoose cursor shape the engine consumes. */
export type ExportCursor = AsyncIterable<Record<string, any>> & {
  close(): Promise<void>;
};

export interface ExportQueryOptions {
  projection: Record<string, 1>;
  readPreference: string;
  batchSize: number;
}

/**
 * Abstract base for ALL export processors (Template Method).
 *
 * The shared engine owns the entire pipeline:
 *   acquire per-tenant lock → mask snapshot → count → stream cursor →
 *   format rows (backpressure) → upload (stream straight to S3 / temp on local)
 *   → publish completion → persist history. Subclasses only:
 *     - provide the module config
 *     - open a lean, projected cursor for the typed filter
 *     - provide a progress count
 *     - expose injected dependencies
 */
export abstract class BaseExportProcessor<
  TJobData extends BaseExportJobData = BaseExportJobData,
> extends BaseTenantConsumer<TJobData, ExportResult> {
  protected abstract readonly logger: Logger;
  protected abstract readonly cls: ClsService;

  protected abstract getModuleConfig(): ExportModuleConfig;
  protected abstract getStorage(): ExportStorageService;
  protected abstract getExportJobModel(): Model<any>;
  protected abstract getLockService(): RedisLockService;
  protected abstract getRedis(): Redis;
  protected abstract getMaskingService(): ExportMaskingService;
  protected abstract getConnection(): Connection;

  /** Open a lean, projected, read-preference-tagged cursor for the filter. */
  protected abstract openCursor(
    data: TJobData,
    opts: ExportQueryOptions,
  ): ExportCursor;

  /** Count matching docs for progress (engine wraps with a time budget). */
  protected abstract countForProgress(
    data: TJobData,
    maxTimeMS: number,
  ): Promise<number>;

  /**
   * Optional lifecycle hook called once per job, after masking / progress setup
   * but before the streaming cursor opens. Subclasses override this to pre-load
   * lookup maps (users, stages, statuses, etc.) so that `ExportColumn.format`
   * functions can resolve ObjectId references to human-readable values.
   *
   * The default implementation is a no-op.
   */
  protected async beforeExport(_data: TJobData): Promise<void> {
    // no-op — subclasses may override
  }

  // ─────────────────────── LIFECYCLE HOOKS ───────────────────────

  @OnWorkerEvent('failed')
  async onFailed(job: Job<TJobData>, error: Error) {
    void super.onFailed(job, error);
    const cancelled = error instanceof ExportCancelledError;
    await this.patchJob(String(job.id), {
      status: cancelled ? 'cancelled' : 'failed',
      failedReason: cancelled ? undefined : error.message,
      cancelledAt: cancelled ? new Date() : undefined,
      completedAt: new Date(),
    });
  }

  // ─────────────────────── MAIN PIPELINE ───────────────────────

  protected async handle(job: Job<TJobData>): Promise<ExportResult> {
    const cfg = this.getModuleConfig();
    const lockKey = `lock:export:${cfg.module}:${job.data.tenantId}`;
    return this.getLockService().acquire(
      lockKey,
      { ttl: LOCK_TTL_MS },
      (signal) => this.runExport(job, signal),
    );
  }

  private async runExport(
    job: Job<TJobData>,
    signal: AbortSignal,
  ): Promise<ExportResult> {
    const data = job.data;
    const cfg = this.getModuleConfig();
    const format = data.format;
    const cap = cfg.hardCap[format];
    const gzip = format === 'csv' && cfg.gzipCsv;

    const columns = this.resolveColumns(cfg, data.columns);
    const progress = new ExportProgressTracker(
      this.getExportJobModel(),
      this.getRedis(),
      String(job.id),
    );

    await progress.update({ status: 'active', startedAt: new Date() });
    await this.assertSecondaryIfRequired();

    const masker = await this.getMaskingService().buildMasker(
      data.tenantId,
      data.userGroupId,
      cfg.maskingResource,
    );

    await this.beforeExport(data);

    const estimatedTotal = await this.safeCount(data);

    const sink = await this.getStorage().openSink(
      this.buildFilename(cfg, format, gzip),
      {
        contentType: this.contentType(format, gzip),
        gzip,
        ttlSeconds: DOWNLOAD_TTL_SECONDS,
      },
    );
    const writer = createExportWriter(format, sink.writable);

    let cursor: ExportCursor | null = null;
    let processed = 0;
    try {
      await writer.writeHeader(columns.map((c) => c.header));

      cursor = this.openCursor(data, {
        projection: this.buildProjection(columns),
        readPreference: READ_PREFERENCE,
        batchSize: cfg.batchSize,
      });

      for await (const doc of cursor) {
        await writer.writeRow(this.buildRow(columns, doc, masker));
        processed++;

        if (processed > cap) {
          throw new ExportLimitExceededError(cap);
        }
        if (processed % cfg.batchSize === 0) {
          if (signal.aborted) throw new Error('Export lock lost');
          if (await progress.isCancelled()) throw new ExportCancelledError();
          await progress.report(job, processed, estimatedTotal);
          await this.delay(cfg.throttleMs);
        }
      }

      await writer.finalize();
      const file = await sink.finalize();
      await progress.complete(job, processed);

      await this.getRedis().publish(
        cfg.completionChannel,
        JSON.stringify({
          tenantId: data.tenantId,
          userId: data.userId,
          jobId: String(job.id),
          downloadUrl: file.downloadUrl,
          expiresAt: file.expiresAt,
          recordCount: processed,
        }),
      );

      await progress.update({
        status: 'completed',
        recordCount: processed,
        downloadUrl: file.downloadUrl,
        fileExpiresAt: new Date(file.expiresAt),
        progress: { processed, total: processed, pct: 100 },
        completedAt: new Date(),
      });

      this.logger.log(
        `Export job ${job.id} (${cfg.module}) done: ${processed} records`,
      );

      return {
        jobId: String(job.id),
        recordCount: processed,
        downloadUrl: file.downloadUrl,
        expiresAt: file.expiresAt,
        storageKey: file.storageKey,
        format,
      };
    } catch (err) {
      await sink.abort();
      throw err;
    } finally {
      await cursor?.close().catch(() => undefined);
      await ExportProgressTracker.clearCancel(
        this.getRedis(),
        String(job.id),
      ).catch(() => undefined);
    }
  }

  // ─────────────────────── HELPERS ───────────────────────

  private buildRow(
    columns: ExportColumn[],
    doc: Record<string, any>,
    masker: ExportMasker,
  ): string[] {
    return columns.map((col) => {
      const raw = this.getByPath(doc, col.path);
      const value = masker.active
        ? masker.maskValue(col.maskKey ?? col.path, raw)
        : raw;
      return col.format ? col.format(value, doc) : this.defaultCell(value);
    });
  }

  private resolveColumns(
    cfg: ExportModuleConfig,
    requested?: string[],
  ): ExportColumn[] {
    if (!requested || requested.length === 0) return [...cfg.columns];
    const allowed = new Set(
      requested.filter((c) => cfg.selectableColumns.has(c)),
    );
    const cols = cfg.columns.filter((c) => allowed.has(c.path));
    return cols.length ? cols : [...cfg.columns];
  }

  private buildProjection(columns: ExportColumn[]): Record<string, 1> {
    const projection: Record<string, 1> = {};
    for (const col of columns) {
      const field = col.path === 'id' ? '_id' : col.path.split('.')[0];
      projection[field] = 1;
    }
    return projection;
  }

  private getByPath(doc: Record<string, any>, path: string): unknown {
    if (path === 'id') return doc._id;
    if (!path.includes('.')) return doc[path];
    return path
      .split('.')
      .reduce<any>((o, k) => (o == null ? undefined : o[k]), doc);
  }

  private defaultCell(value: unknown): string {
    if (value == null) return '';
    if (Array.isArray(value))
      return value.map((v) => this.scalar(v)).join('; ');
    return this.scalar(value);
  }

  private scalar(value: unknown): string {
    if (value == null) return '';
    if (value instanceof Date) return value.toISOString();
    return String(value);
  }

  private contentType(format: string, gzip: boolean): string {
    if (gzip) return 'application/gzip';
    if (format === 'xlsx') {
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    }
    return 'text/csv; charset=utf-8';
  }

  private buildFilename(
    cfg: ExportModuleConfig,
    format: string,
    gzip: boolean,
  ): string {
    const date = new Date().toISOString().slice(0, 10);
    const base = `${cfg.module}s-export-${date}.${format}`;
    return gzip ? `${base}.gz` : base;
  }

  private async safeCount(data: TJobData): Promise<number | null> {
    try {
      const n = await this.countForProgress(data, COUNT_MAX_TIME_MS);
      return n > 0 ? n : null;
    } catch {
      // count too slow / errored — fall back to processed-only progress.
      return null;
    }
  }

  private async assertSecondaryIfRequired(): Promise<void> {
    if (process.env.EXPORT_REQUIRE_SECONDARY !== 'true') return;
    try {
      const db = this.getConnection().db;
      const hello: any = await db?.admin().command({ hello: 1 });
      const members =
        (hello?.hosts?.length ?? 0) + (hello?.passives?.length ?? 0);
      if (hello?.setName && members > 1) return;
    } catch {
      // fall through to throw — we cannot confirm a secondary exists
    }
    throw new SecondaryUnavailableError();
  }

  private async patchJob(
    bullJobId: string,
    patch: Record<string, any>,
  ): Promise<void> {
    try {
      // Runs from the 'failed' worker event — OUTSIDE the tenant CLS wrapper.
      // bullJobId is globally unique, so a platform query is safe here.
      await this.getExportJobModel().updateOne({ bullJobId }, { $set: patch }, {
        isPlatformQuery: true,
      } as any);
    } catch (err) {
      this.logger.warn(
        `Failed to update export history (bullJobId=${bullJobId}): ${(err as Error).message}`,
      );
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
