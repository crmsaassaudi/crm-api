import { Logger } from '@nestjs/common';
import { OnWorkerEvent } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { Model, Connection } from 'mongoose';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import Redis from 'ioredis';
import { Readable } from 'stream';

import { BaseTenantConsumer } from '../../queue/base-tenant.consumer';
import {
  BaseImportJobData,
  DedupMatchingField,
  ImportErrorCode,
  ImportModuleConfig,
  ImportPreview,
  ImportResult,
  ImportRowError,
  ImportSummary,
  MappedRow,
} from './types';
import { ImportStorageService } from './import-storage.service';
import {
  ImportReportService,
  ImportReportWriter,
} from './import-report.service';
import { ImportDedupEngine, DedupConfig } from './import-dedup.service';
import { ImportReferenceResolver } from './import-reference-resolver.service';
import { ImportProgressTracker } from './import-progress.service';
import { createParser, detectFormat } from './import-parser.factory';
import { RedisLockService } from '../../redis/redis-lock.service';

const LOCK_TTL_MS = 10 * 60 * 1000; // 10 min, heartbeat-renewed by lock service
const DEFAULT_THROTTLE_MS = 60; // pause between batches to spare MongoDB CPU

/**
 * Abstract base class for ALL import processors.
 *
 * Uses Template Method pattern: the shared engine handles the entire import
 * pipeline (stream → batch → dedup → validate → write → report), while
 * module-specific processors override abstract methods for:
 *   - Field mapping (mapRow)
 *   - Row validation (validateRow)
 *   - Insert/Update document building (buildInsert, buildOverwrite, buildMerge)
 *   - Dedup value extraction (extractDedupValues)
 *   - Post-write hooks (afterBatchWrite)
 *
 * Subclass convention:
 *   1. Extend this class with your module's job data type
 *   2. Implement all abstract methods
 *   3. Inject required dependencies in the subclass constructor
 *   4. Decorate with @Processor(queueName, { concurrency: N })
 */
export abstract class BaseImportProcessor<
  TJobData extends BaseImportJobData = BaseImportJobData,
> extends BaseTenantConsumer<TJobData, ImportResult> {
  protected abstract readonly logger: Logger;
  protected abstract readonly cls: ClsService;

  /**
   * Module configuration — drives the shared engine.
   * Must be set by the subclass constructor or as a class property.
   */
  protected abstract readonly moduleConfig: ImportModuleConfig;

  /** Mongoose model for the target entity (e.g. ContactModel, DealModel). */
  protected abstract getEntityModel(): Model<any>;

  /** Import storage service for this module. */
  protected abstract getStorage(): ImportStorageService;

  /** Import report service for this module. */
  protected abstract getReportService(): ImportReportService;

  /** Redis lock service. */
  protected abstract getLockService(): RedisLockService;

  /** Event emitter for automation events. */
  protected abstract getEventEmitter(): EventEmitter2;

  /** Redis client for pub/sub. */
  protected abstract getRedis(): Redis;

  /** Mongoose connection for reference resolver. */
  protected abstract getConnection(): Connection;

  /** Import job model for progress tracking. */
  protected abstract getImportJobModel(): Model<any>;

  // ─────────────────────── ABSTRACT: Module-specific logic ────────────────

  /**
   * Map a raw CSV/XLSX row onto entity fields using the user's column mapping.
   * Must return scalar fields and array fields separately.
   */
  protected abstract mapRow(
    raw: Record<string, string>,
    mapping: Record<string, string>,
    row: number,
  ): MappedRow;

  /**
   * Validate a mapped row beyond required-field checks.
   * Return errors for any module-specific validation failures.
   * The base class already checks required fields.
   */
  protected abstract validateRow(
    mapped: MappedRow,
    data: TJobData,
  ): ImportRowError[];

  /**
   * Extract dedup values from a mapped row for a given matching field.
   * E.g. for contacts, field='emails' returns the mapped row's email values.
   */
  protected abstract extractDedupValues(
    row: MappedRow,
    field: DedupMatchingField,
  ): string[];

  /**
   * Build the insert document for a new record.
   * Must include tenantId, createdById, updatedById, timestamps.
   */
  protected abstract buildInsert(
    mapped: MappedRow,
    data: TJobData,
    now: Date,
    resolvedRefs: Record<string, string>,
  ): Record<string, any>;

  /**
   * Build the $set update for an overwrite (full replace of mapped fields).
   */
  protected abstract buildOverwrite(
    mapped: MappedRow,
    data: TJobData,
    resolvedRefs: Record<string, string>,
  ): Record<string, any>;

  /**
   * Build the update document for a merge (fill empty, append arrays).
   * Return null if the merge produces no changes.
   */
  protected abstract buildMerge(
    mapped: MappedRow,
    existing: any,
    data: TJobData,
    errors: ImportRowError[],
    resolvedRefs: Record<string, string>,
  ): Record<string, any> | null;

  /**
   * Optional hook called after a successful batch write.
   * Use for emitting automation events, activity logs, etc.
   */

  protected async afterBatchWrite(
    _affected: Array<{ id?: string; type: 'insert' | 'update'; row: number }>,
    _data: TJobData,
  ): Promise<void> {
    // Default: no-op. Override in subclass if needed.
  }

  // ─────────────────────── LIFECYCLE HOOKS ────────────────────────────

  /** Update MongoDB history when a job fails. */
  @OnWorkerEvent('failed')
  async onFailed(job: Job<TJobData>, error: Error) {
    void super.onFailed(job, error);
    await this.updateImportJob(String(job.id), {
      status: 'failed',
      failedReason: error.message,
      completedAt: new Date(),
    });
  }

  // ─────────────────────── MAIN PIPELINE ────────────────────────────

  protected async handle(job: Job<TJobData>): Promise<ImportResult> {
    const { tenantId } = job.data;
    const lockKey = `lock:${this.moduleConfig.module}:import:${tenantId}`;

    return this.getLockService().acquire(lockKey, LOCK_TTL_MS, () =>
      this.runImport(job),
    );
  }

  private async runImport(job: Job<TJobData>): Promise<ImportResult> {
    const data = job.data;
    const dryRun = data.dryRun ?? false;
    const format = detectFormat(data.fileKey);
    const parser = createParser(format);
    const storage = this.getStorage();
    const reportService = this.getReportService();
    const report = reportService.createWriter(String(job.id), data.tenantId);

    // Initialize reference resolver if this module has reference fields.
    let refResolver: ImportReferenceResolver | undefined;
    if (this.moduleConfig.referenceFields.length > 0) {
      refResolver = new ImportReferenceResolver(
        this.getConnection(),
        data.tenantId,
        this.moduleConfig.referenceFields,
      );
      await refResolver.initialize();
    }

    // Initialize progress tracker.
    const progress = new ImportProgressTracker(
      this.getImportJobModel(),
      String(job.id),
    );

    // Mark as active in MongoDB history.
    await this.updateImportJob(String(job.id), { status: 'active' });

    const summary: ImportSummary = {
      total: 0,
      inserted: 0,
      updated: 0,
      skipped: 0,
      errors: 0,
    };

    const dedupEngine = new ImportDedupEngine();
    const dedupConfig: DedupConfig | undefined = data.deduplication
      ? {
          matchingFields: data.deduplication.matchingFields,
          policy: data.deduplication.policy,
        }
      : undefined;

    let stream: Readable | null = null;
    let batch: MappedRow[] = [];
    let rowNum = 0;

    try {
      stream = await storage.openImportStream(data.fileKey);

      for await (const raw of parser.parse(stream)) {
        rowNum++;
        const mapped = this.mapRow(raw, data.mapping, rowNum);
        batch.push(mapped);

        if (batch.length >= this.moduleConfig.batchSize) {
          await this.processBatch(
            batch,
            data,
            dedupEngine,
            dedupConfig,
            refResolver,
            summary,
            report,
            dryRun,
          );
          batch = [];
          await progress.report(job, summary.total, data.estimatedRows);
          await this.delay(DEFAULT_THROTTLE_MS);
        }
      }

      if (batch.length > 0) {
        await this.processBatch(
          batch,
          data,
          dedupEngine,
          dedupConfig,
          refResolver,
          summary,
          report,
          dryRun,
        );
      }
    } finally {
      stream?.destroy();
    }

    // ── Finalize ──

    if (dryRun) {
      const preview: ImportPreview = {
        wouldInsert: summary.inserted,
        wouldUpdate: summary.updated,
        wouldSkip: summary.skipped,
        validationErrors: summary.errors,
      };
      await report.discard();
      await progress.complete(job, summary.total);
      await this.updateImportJob(String(job.id), {
        status: 'completed',
        preview,
        progress: { processed: summary.total, total: summary.total, pct: 100 },
        completedAt: new Date(),
      });
      return { jobId: String(job.id), dryRun: true, preview };
    }

    const finalized = await report.finalize(summary);
    await progress.complete(job, summary.total);

    // Publish completion event via Redis pub/sub.
    await this.getRedis().publish(
      this.moduleConfig.completionChannel,
      JSON.stringify({
        tenantId: data.tenantId,
        userId: data.userId,
        jobId: String(job.id),
        fileName: data.fileName,
        summary,
        reportUrl: finalized?.reportUrl,
      }),
    );

    this.logger.log(
      `Import job ${job.id} done: ${JSON.stringify(summary)} ` +
        `(report=${finalized?.reportUrl ?? 'none'})`,
    );

    // Best-effort cleanup of the uploaded source file.
    await storage.deleteImportFile(data.fileKey);

    await this.updateImportJob(String(job.id), {
      status: 'completed',
      summary,
      reportUrl: finalized?.reportUrl,
      progress: { processed: summary.total, total: summary.total, pct: 100 },
      completedAt: new Date(),
    });

    return {
      jobId: String(job.id),
      dryRun: false,
      summary,
      reportUrl: finalized?.reportUrl,
    };
  }

  // ─────────────────────── BATCH PROCESSING ────────────────────────────

  private async processBatch(
    batch: MappedRow[],
    data: TJobData,
    dedupEngine: ImportDedupEngine,
    dedupConfig: DedupConfig | undefined,
    refResolver: ImportReferenceResolver | undefined,
    summary: ImportSummary,
    report: ImportReportWriter,
    dryRun: boolean,
  ): Promise<void> {
    const errors: ImportRowError[] = [];
    const ops: any[] = [];
    const opMeta: Array<{ row: number; type: 'insert' | 'update' }> = [];
    const affected: Array<{
      id?: string;
      type: 'insert' | 'update';
      row: number;
    }> = [];

    summary.total += batch.length;

    // ── Step 1: Required-field validation ──
    const valid = this.validateBatchRows(batch, data, summary, errors);

    // ── Step 2: Reference resolution ──
    const { validWithRefs, resolvedRefs } = this.resolveRefs(
      valid,
      refResolver,
      summary,
      errors,
    );

    // ── Step 3: Dedup lookup ──
    const dedupMatches = dedupConfig
      ? await dedupEngine.lookupBatch(
          this.getEntityModel(),
          data.tenantId,
          validWithRefs,
          dedupConfig,
          (row, field) => this.extractDedupValues(row, field),
        )
      : null;

    // ── Step 4: Build bulk-write ops ──
    this.buildBatchOps(
      validWithRefs,
      data,
      dedupEngine,
      dedupMatches,
      dedupConfig,
      resolvedRefs,
      summary,
      errors,
      ops,
      opMeta,
      affected,
    );

    // ── Step 5: Execute (skip for dry-run) ──
    await this.executeBatchOps(
      ops,
      opMeta,
      affected,
      data,
      summary,
      report,
      errors,
      dryRun,
    );
  }

  /** Step 1: Filter out rows missing required fields or failing module validation. */
  private validateBatchRows(
    batch: MappedRow[],
    data: TJobData,
    summary: ImportSummary,
    errors: ImportRowError[],
  ): MappedRow[] {
    const valid: MappedRow[] = [];
    for (const m of batch) {
      const missing = this.moduleConfig.requiredFields.filter(
        (f) => !m.fields[f] && (m.arrayFields[f]?.length ?? 0) <= 0,
      );
      if (missing.length) {
        summary.errors++;
        errors.push({
          row: m.row,
          code: ImportErrorCode.REQUIRED_FIELD_MISSING,
          field: missing.join(','),
          reason: `Missing required field(s): ${missing.join(', ')}`,
        });
        continue;
      }
      const moduleErrors = this.validateRow(m, data);
      if (moduleErrors.length) {
        summary.errors += moduleErrors.length;
        errors.push(...moduleErrors);
        continue;
      }
      valid.push(m);
    }
    return valid;
  }

  /** Step 2: Resolve reference fields for each valid row; drop rows that fail. */
  private resolveRefs(
    valid: MappedRow[],
    refResolver: ImportReferenceResolver | undefined,
    summary: ImportSummary,
    errors: ImportRowError[],
  ): {
    validWithRefs: MappedRow[];
    resolvedRefs: Map<number, Record<string, string>>;
  } {
    const resolvedRefs = new Map<number, Record<string, string>>();
    if (refResolver) {
      for (const m of valid) {
        const result = refResolver.resolveRow(m.row, m.fields);
        if (result.errors.length) {
          summary.errors += result.errors.length;
          errors.push(...result.errors);
          continue;
        }
        resolvedRefs.set(m.row, result.resolved);
      }
    }
    const validWithRefs = refResolver
      ? valid.filter((m) => resolvedRefs.has(m.row))
      : valid;
    return { validWithRefs, resolvedRefs };
  }

  /** Step 4: Populate ops / opMeta / affected arrays from dedup-resolved rows. */
  private buildBatchOps(
    validWithRefs: MappedRow[],
    data: TJobData,
    dedupEngine: ImportDedupEngine,
    dedupMatches: Map<number, any> | null,
    dedupConfig: DedupConfig | undefined,
    resolvedRefs: Map<number, Record<string, string>>,
    summary: ImportSummary,
    errors: ImportRowError[],
    ops: any[],
    opMeta: Array<{ row: number; type: 'insert' | 'update' }>,
    affected: Array<{ id?: string; type: 'insert' | 'update'; row: number }>,
  ): void {
    const now = new Date();
    const policy = dedupConfig?.policy;

    for (const m of validWithRefs) {
      const refs = resolvedRefs.get(m.row) ?? {};
      const match = dedupMatches?.get(m.row);

      if (match?.claimedByEarlierRow) {
        summary.skipped++;
        errors.push(dedupEngine.buildDuplicateInFileError(m));
        continue;
      }

      if (!match?.existing || policy === 'create_new') {
        ops.push({
          insertOne: { document: this.buildInsert(m, data, now, refs) },
        });
        opMeta.push({ row: m.row, type: 'insert' });
        summary.inserted++;
        affected.push({ type: 'insert', row: m.row });
        continue;
      }

      if (policy === 'skip') {
        summary.skipped++;
        continue;
      }

      const update =
        policy === 'overwrite'
          ? this.buildOverwrite(m, data, refs)
          : this.buildMerge(m, match.existing, data, errors, refs);

      if (!update) {
        summary.skipped++;
        continue;
      }

      ops.push({ updateOne: { filter: { _id: match.existing._id }, update } });
      opMeta.push({ row: m.row, type: 'update' });
      summary.updated++;
      affected.push({
        type: 'update',
        id: String(match.existing._id),
        row: m.row,
      });
    }
  }

  /** Step 5: Run bulkWrite and call post-write hooks. */
  private async executeBatchOps(
    ops: any[],
    opMeta: Array<{ row: number; type: 'insert' | 'update' }>,
    affected: Array<{ id?: string; type: 'insert' | 'update'; row: number }>,
    data: TJobData,
    summary: ImportSummary,
    report: ImportReportWriter,
    errors: ImportRowError[],
    dryRun: boolean,
  ): Promise<void> {
    if (dryRun) {
      await report.appendErrors(errors);
      return;
    }

    if (ops.length > 0) {
      const failed = await this.executeBulk(ops, opMeta, errors, summary);
      for (const meta of failed) {
        if (meta.type === 'insert') summary.inserted--;
        else summary.updated--;
      }
      if (data.triggerAutomations) {
        const failedRows = new Set(failed.map((f) => f.row));
        const successfulAffected = affected.filter(
          (a) => !failedRows.has(a.row),
        );
        await this.afterBatchWrite(successfulAffected, data);
      }
    }

    await report.appendErrors(errors);
  }

  private async executeBulk(
    ops: any[],
    opMeta: Array<{ row: number; type: 'insert' | 'update' }>,
    errors: ImportRowError[],
    summary: ImportSummary,
  ): Promise<Array<{ row: number; type: 'insert' | 'update' }>> {
    const failed: Array<{ row: number; type: 'insert' | 'update' }> = [];
    try {
      await this.getEntityModel().bulkWrite(ops, { ordered: false });
    } catch (err: any) {
      const writeErrors: any[] =
        err?.writeErrors ?? err?.result?.writeErrors ?? [];
      if (writeErrors.length === 0) {
        throw err;
      }
      for (const we of writeErrors) {
        const index = we.index ?? we.err?.index;
        const meta = opMeta[index];
        summary.errors++;
        failed.push(meta);
        errors.push({
          row: meta?.row ?? -1,
          code: ImportErrorCode.DB_WRITE_FAILED,
          reason: `DB write failed: ${we.errmsg ?? we.err?.errmsg ?? 'unknown'}`,
        });
      }
    }
    return failed;
  }

  // ─────────────────────── HELPERS ────────────────────────────

  private async updateImportJob(
    bullJobId: string,
    update: Record<string, any>,
  ): Promise<void> {
    try {
      await this.getImportJobModel().updateOne({ bullJobId }, { $set: update });
    } catch (err) {
      this.logger.warn(
        `Failed to update import history (bullJobId=${bullJobId}): ${(err as Error).message}`,
      );
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
