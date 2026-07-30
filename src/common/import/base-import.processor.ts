import { Logger } from '@nestjs/common';
import { OnWorkerEvent } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { Model, Connection, ClientSession, Types } from 'mongoose';
import { ClsService } from 'nestjs-cls';
import Redis from 'ioredis';
import { Readable } from 'stream';

import { BaseTenantConsumer } from '../../queue/base-tenant.consumer';
import {
  BaseImportJobData,
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
import { AutomationOutboxService } from '../../automation-rules/events/automation-outbox.service';
import { AutomationEventPayload } from '../../automation-rules/events/automation-event.payload';

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
 *   - Durable automation event generation
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

  /** Redis client for pub/sub. */
  protected abstract getRedis(): Redis;

  /** Mongoose connection for reference resolver. */
  protected abstract getConnection(): Connection;

  /** Import job model for progress tracking. */
  protected abstract getImportJobModel(): Model<any>;

  /** Durable workflow outbox used to atomically bridge imported records. */
  protected abstract getAutomationOutbox(): AutomationOutboxService;

  // ─────────────────────── ABSTRACT: Module-specific logic ────────────────

  /**
   * Map a raw CSV/XLSX row onto entity fields using the user's column mapping.
   * Must return scalar fields and array fields separately.
   *
   * `data` is passed rather than read from instance state because a processor
   * instance handles several jobs concurrently (`concurrency: 3`); per-job
   * settings held on `this` would leak between tenants.
   */
  protected abstract mapRow(
    raw: Record<string, string>,
    mapping: Record<string, string>,
    row: number,
    data: TJobData,
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
    field: string,
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
   * Optional hook called once per batch, after dedup lookup but before
   * buildInsert/buildOverwrite/buildMerge build the write documents.
   *
   * Rows are passed by reference — mutate `row.fields` / `row.arrayFields`
   * in place to rewrite values that need a batch-wide resolution pass
   * (e.g. resolving free-text tag names to catalog tag ids exactly once
   * per batch instead of once per row).
   */
  protected async beforeBuildOps(
    _rows: MappedRow[],
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
        const mapped = this.mapRow(raw, data.mapping, rowNum, data);
        batch.push(mapped);

        if (batch.length >= this.moduleConfig.batchSize) {
          await this.processBatch(batch, data, {
            dedupEngine,
            dedupConfig,
            refResolver,
            summary,
            report,
            dryRun,
          });
          batch = [];
          await progress.report(job, summary.total, data.estimatedRows);
          await this.delay(DEFAULT_THROTTLE_MS);
        }
      }

      if (batch.length > 0) {
        await this.processBatch(batch, data, {
          dedupEngine,
          dedupConfig,
          refResolver,
          summary,
          report,
          dryRun,
        });
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
    context: {
      dedupEngine: ImportDedupEngine;
      dedupConfig: DedupConfig | undefined;
      refResolver: ImportReferenceResolver | undefined;
      summary: ImportSummary;
      report: ImportReportWriter;
      dryRun: boolean;
    },
  ): Promise<void> {
    const errors: ImportRowError[] = [];
    const ops: any[] = [];
    const opMeta: Array<{ row: number; type: 'insert' | 'update' }> = [];
    const affected: Array<{
      id?: string;
      type: 'insert' | 'update';
      row: number;
    }> = [];

    context.summary.total += batch.length;

    // ── Step 1: Required-field validation ──
    const valid = this.validateBatchRows(batch, data, context.summary, errors);

    // ── Step 2: Reference resolution ──
    const { validWithRefs, resolvedRefs } = this.resolveRefs(
      valid,
      context.refResolver,
      context.summary,
      errors,
    );

    // ── Step 3: Dedup lookup ──
    const dedupMatches = context.dedupConfig
      ? await context.dedupEngine.lookupBatch(
          this.getEntityModel(),
          data.tenantId,
          validWithRefs,
          context.dedupConfig,
          (row, field) => this.extractDedupValues(row, field),
        )
      : null;

    // ── Step 3.5: Batch-wide pre-write resolution (e.g. tag name → id) ──
    await this.beforeBuildOps(validWithRefs, data);

    // ── Step 4: Build bulk-write ops ──
    this.buildBatchOps({
      rows: validWithRefs,
      data,
      dedupEngine: context.dedupEngine,
      dedupMatches,
      dedupConfig: context.dedupConfig,
      resolvedRefs,
      summary: context.summary,
      errors,
      ops,
      opMeta,
      affected,
    });

    // ── Step 5: Execute (skip for dry-run) ──
    await this.executeBatchOps(ops, opMeta, affected, data, context, errors);
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
  private buildBatchOps(ctx: {
    rows: MappedRow[];
    data: TJobData;
    dedupEngine: ImportDedupEngine;
    dedupMatches: Map<number, any> | null;
    dedupConfig: DedupConfig | undefined;
    resolvedRefs: Map<number, Record<string, string>>;
    summary: ImportSummary;
    errors: ImportRowError[];
    ops: any[];
    opMeta: Array<{ row: number; type: 'insert' | 'update' }>;
    affected: Array<{ id?: string; type: 'insert' | 'update'; row: number }>;
  }): void {
    const now = new Date();
    const policy = ctx.dedupConfig?.policy;

    for (const m of ctx.rows) {
      const refs = ctx.resolvedRefs.get(m.row) ?? {};
      const match = ctx.dedupMatches?.get(m.row);

      if (match?.claimedByEarlierRow) {
        ctx.summary.skipped++;
        ctx.errors.push(ctx.dedupEngine.buildDuplicateInFileError(m));
        continue;
      }

      if (!match?.existing || policy === 'create_new') {
        const document = this.buildInsert(m, ctx.data, now, refs);
        document._id ??= new Types.ObjectId();
        ctx.ops.push({
          insertOne: { document },
        });
        ctx.opMeta.push({ row: m.row, type: 'insert' });
        ctx.summary.inserted++;
        ctx.affected.push({
          type: 'insert',
          id: String(document._id),
          row: m.row,
        });
        continue;
      }

      if (policy === 'skip') {
        ctx.summary.skipped++;
        continue;
      }

      const update =
        policy === 'overwrite'
          ? this.buildOverwrite(m, ctx.data, refs)
          : this.buildMerge(m, match.existing, ctx.data, ctx.errors, refs);

      if (!update) {
        ctx.summary.skipped++;
        continue;
      }

      ctx.ops.push({
        updateOne: { filter: { _id: match.existing._id }, update },
      });
      ctx.opMeta.push({ row: m.row, type: 'update' });
      ctx.summary.updated++;
      ctx.affected.push({
        type: 'update',
        id: String(match.existing._id),
        row: m.row,
      });
    }
  }

  /** Step 5: atomically run bulkWrite and persist workflow events. */
  private async executeBatchOps(
    ops: any[],
    opMeta: Array<{ row: number; type: 'insert' | 'update' }>,
    affected: Array<{ id?: string; type: 'insert' | 'update'; row: number }>,
    data: TJobData,
    context: {
      summary: ImportSummary;
      report: ImportReportWriter;
      dryRun: boolean;
    },
    errors: ImportRowError[],
  ): Promise<void> {
    if (context.dryRun) {
      await context.report.appendErrors(errors);
      return;
    }

    if (ops.length > 0) {
      const failed = await this.executeBulkWithOutbox(
        ops,
        opMeta,
        affected,
        data,
        errors,
        context.summary,
      );
      for (const meta of failed) {
        if (meta.type === 'insert') context.summary.inserted--;
        else context.summary.updated--;
      }
    }

    await context.report.appendErrors(errors);
  }

  private async executeBulkWithOutbox(
    ops: any[],
    opMeta: Array<{ row: number; type: 'insert' | 'update' }>,
    affected: Array<{ id?: string; type: 'insert' | 'update'; row: number }>,
    data: TJobData,
    errors: ImportRowError[],
    summary: ImportSummary,
  ): Promise<Array<{ row: number; type: 'insert' | 'update' }>> {
    const outbox = this.getAutomationOutbox();
    try {
      await outbox.runWithEvents(async (session) => {
        await this.getEntityModel().bulkWrite(ops, {
          ordered: false,
          session,
        });
        return {
          result: true,
          payloads: data.triggerAutomations
            ? await this.buildAutomationPayloads(affected, data, session)
            : [],
        };
      });
      return [];
    } catch (error: any) {
      const writeErrors: any[] =
        error?.writeErrors ?? error?.result?.writeErrors ?? [];
      if (writeErrors.length === 0) throw error;
      // A write error aborts a Mongo transaction. Retry rows independently so
      // valid rows still import while every successful row remains atomic with
      // its outbox event.
      return this.retryOpsIndividually(
        ops,
        opMeta,
        affected,
        data,
        errors,
        summary,
        outbox,
      );
    }
  }

  private async retryOpsIndividually(
    ops: any[],
    opMeta: Array<{ row: number; type: 'insert' | 'update' }>,
    affected: Array<{ id?: string; type: 'insert' | 'update'; row: number }>,
    data: TJobData,
    errors: ImportRowError[],
    summary: ImportSummary,
    outbox: AutomationOutboxService,
  ): Promise<Array<{ row: number; type: 'insert' | 'update' }>> {
    const failed: Array<{ row: number; type: 'insert' | 'update' }> = [];
    for (let index = 0; index < ops.length; index++) {
      const meta = opMeta[index];
      try {
        await outbox.runWithEvents(async (session) => {
          await this.getEntityModel().bulkWrite([ops[index]], {
            ordered: true,
            session,
          });
          return {
            result: true,
            payloads: data.triggerAutomations
              ? await this.buildAutomationPayloads(
                  [affected[index]],
                  data,
                  session,
                )
              : [],
          };
        });
      } catch (error: any) {
        summary.errors++;
        failed.push(meta);
        errors.push({
          row: meta?.row ?? -1,
          code: ImportErrorCode.DB_WRITE_FAILED,
          reason: `DB write failed: ${error?.message ?? 'unknown'}`,
        });
      }
    }
    return failed;
  }

  private async buildAutomationPayloads(
    affected: Array<{ id?: string; type: 'insert' | 'update'; row: number }>,
    data: TJobData,
    session: ClientSession,
  ): Promise<AutomationEventPayload[]> {
    const ids = affected.map((item) => item.id).filter(Boolean) as string[];
    if (ids.length !== affected.length) {
      throw new Error(
        'Import write is missing an aggregate id for automation.',
      );
    }
    const records = await this.getEntityModel()
      .find({ _id: { $in: ids }, tenantId: data.tenantId })
      .session(session)
      .lean()
      .exec();
    const byId = new Map(
      records.map((record: any) => [String(record._id), record]),
    );
    const object = this.moduleConfig
      .displayName as AutomationEventPayload['object'];
    return affected.map((item) => {
      const record = byId.get(item.id!);
      if (!record) {
        throw new Error(
          `Imported ${object} ${item.id} was not found after write.`,
        );
      }
      return {
        tenantId: data.tenantId,
        event: item.type === 'insert' ? 'record_created' : 'field_updated',
        object,
        recordId: item.id!,
        data: record,
        automationDepth: 0,
        triggerUserId: data.userId,
      };
    });
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
