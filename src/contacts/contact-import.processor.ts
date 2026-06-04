import { Processor, OnWorkerEvent } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Job } from 'bullmq';
import { Model } from 'mongoose';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import Redis from 'ioredis';
import { Readable } from 'stream';

import {
  BaseTenantConsumer,
  TenantJobData,
} from '../queue/base-tenant.consumer';
import { IOREDIS_CLIENT } from '../redis/redis.tokens';
import { RedisLockService } from '../redis/redis-lock.service';
import {
  ContactSchemaClass,
  ContactSchemaDocument,
} from './infrastructure/persistence/document/entities/contact.schema';
import { ContactExportStorageService } from './contact-export-storage.service';
import {
  ContactImportReportService,
  ImportReportWriter,
  ImportRowError,
  ImportSummary,
} from './contact-import-report.service';
import {
  CONTACT_IMPORT_QUEUE,
  IMPORT_ARRAY_FIELDS,
  IMPORT_BATCH_SIZE,
  IMPORT_MAPPABLE_FIELDS,
} from './contacts.constants';
import { DedupMatchingField, DedupPolicy } from './dto/start-import.dto';
import { createParser, detectFormat } from './import/import-parser.factory';
import { buildAutomationEventName } from '../automation-rules/events/automation-event.payload';
import {
  ImportJobSchemaClass,
  ImportJobDocument,
} from './infrastructure/persistence/document/entities/import-job.schema';

export interface ImportTenantSettings {
  uniqueEmail: boolean;
  uniquePhone: boolean;
  multipleEmailsAllowed: boolean;
  multiplePhonesAllowed: boolean;
}

export interface ContactImportJobData extends TenantJobData {
  fileKey: string;
  mapping: Record<string, string>;
  deduplication?: {
    matchingFields: DedupMatchingField[];
    policy: DedupPolicy;
  };
  dryRun?: boolean;
  triggerAutomations?: boolean;
  estimatedRows?: number;
  fileName?: string;
  tenantSettings: ImportTenantSettings;
}

export interface ContactImportResult {
  jobId: string;
  dryRun: boolean;
  summary?: ImportSummary;
  preview?: {
    wouldInsert: number;
    wouldUpdate: number;
    wouldSkip: number;
    validationErrors: number;
  };
  reportUrl?: string;
}

const SCALAR_FIELDS = IMPORT_MAPPABLE_FIELDS.filter(
  (f) => !IMPORT_ARRAY_FIELDS.has(f),
);
const LOCK_TTL_MS = 10 * 60 * 1000; // 10 min, heartbeat-renewed by lock service
const THROTTLE_MS = 60; // pause between batches to spare MongoDB CPU

/** A single source row mapped onto Contact fields, ready to dedup/write. */
interface MappedRow {
  row: number;
  fields: Record<string, string>; // scalar fields
  emails: string[];
  phones: string[];
}

@Processor(CONTACT_IMPORT_QUEUE, { concurrency: 3 })
export class ContactImportProcessor extends BaseTenantConsumer<
  ContactImportJobData,
  ContactImportResult
> {
  protected readonly logger = new Logger(ContactImportProcessor.name);
  protected readonly cls: ClsService;

  constructor(
    @InjectModel(ContactSchemaClass.name)
    private readonly contactModel: Model<ContactSchemaDocument>,
    private readonly storage: ContactExportStorageService,
    private readonly reportService: ContactImportReportService,
    private readonly lockService: RedisLockService,
    private readonly eventEmitter: EventEmitter2,
    cls: ClsService,
    @Inject(IOREDIS_CLIENT) private readonly redis: Redis,
    @InjectModel(ImportJobSchemaClass.name)
    private readonly importJobModel: Model<ImportJobDocument>,
  ) {
    super();
    this.cls = cls;
  }

  /** Update MongoDB history when a job fails (overrides BaseConsumer.onFailed). */
  @OnWorkerEvent('failed')
  async onFailed(job: Job, error: Error) {
    super.onFailed(job, error);
    await this.updateImportJob(String(job.id), {
      status: 'failed',
      failedReason: error.message,
      completedAt: new Date(),
    });
  }

  protected async handle(
    job: Job<ContactImportJobData>,
  ): Promise<ContactImportResult> {
    const { tenantId } = job.data;
    // Per-tenant lock: serialize imports for one tenant so concurrent jobs
    // can't insert the same contact twice (dedup queries wouldn't see each
    // other's in-flight inserts). Global throughput is still bounded by the
    // processor's concurrency:3.
    const lockKey = `lock:contact:import:${tenantId}`;
    return this.lockService.acquire(lockKey, LOCK_TTL_MS, () =>
      this.runImport(job),
    );
  }

  private async runImport(
    job: Job<ContactImportJobData>,
  ): Promise<ContactImportResult> {
    const data = job.data;
    const dryRun = data.dryRun ?? false;
    const format = detectFormat(data.fileKey);
    const parser = createParser(format);
    const report = this.reportService.createWriter(
      String(job.id),
      data.tenantId,
    );

    // Mark as active in MongoDB history
    await this.updateImportJob(String(job.id), { status: 'active' });

    const summary: ImportSummary = {
      total: 0,
      inserted: 0,
      updated: 0,
      skipped: 0,
      errors: 0,
    };

    // Set of dedup keys claimed by inserts already queued in THIS run, so two
    // rows in the same file with the same email/phone don't both insert.
    const claimedKeys = new Set<string>();
    const dedupFields = data.deduplication?.matchingFields ?? [];
    const policy = data.deduplication?.policy;

    let stream: Readable | null = null;
    let batch: MappedRow[] = [];
    let rowNum = 0;

    try {
      stream = await this.storage.openImportStream(data.fileKey);

      for await (const raw of parser.parse(stream)) {
        rowNum++;
        const mapped = this.mapRow(raw, data.mapping, rowNum);
        batch.push(mapped);

        if (batch.length >= IMPORT_BATCH_SIZE) {
          await this.processBatch(
            batch,
            data,
            dedupFields,
            policy,
            claimedKeys,
            summary,
            report,
            dryRun,
          );
          batch = [];
          await this.reportProgress(job, summary.total, data.estimatedRows);
          await this.delay(THROTTLE_MS);
        }
      }

      if (batch.length > 0) {
        await this.processBatch(
          batch,
          data,
          dedupFields,
          policy,
          claimedKeys,
          summary,
          report,
          dryRun,
        );
      }
    } finally {
      // Guard against fd / socket leaks if the loop throws mid-stream.
      stream?.destroy();
    }

    if (dryRun) {
      const preview = {
        wouldInsert: summary.inserted,
        wouldUpdate: summary.updated,
        wouldSkip: summary.skipped,
        validationErrors: summary.errors,
      };
      await report.discard();
      await job.updateProgress({
        processed: summary.total,
        total: summary.total,
        pct: 100,
      });
      // Update MongoDB for dry-run completion
      await this.updateImportJob(String(job.id), {
        status: 'completed',
        preview,
        progress: { processed: summary.total, total: summary.total, pct: 100 },
        completedAt: new Date(),
      });
      return { jobId: String(job.id), dryRun: true, preview };
    }

    const finalized = await report.finalize(summary);
    await job.updateProgress({
      processed: summary.total,
      total: summary.total,
      pct: 100,
    });

    // Worker has no Socket.IO server — publish to Redis so the API process's
    // OmniGateway can broadcast to the user who triggered the import.
    await this.redis.publish(
      'socket:contact:import:completed',
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
    await this.storage.deleteImportFile(data.fileKey);

    // Update MongoDB for real import completion
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

  // ─────────────────────────── row mapping ───────────────────────────

  private mapRow(
    raw: Record<string, string>,
    mapping: Record<string, string>,
    row: number,
  ): MappedRow {
    const fields: Record<string, string> = {};
    const emails: string[] = [];
    const phones: string[] = [];

    for (const [header, field] of Object.entries(mapping)) {
      const value = (raw[header] ?? '').toString().trim();
      if (!value) continue;
      if (field === 'emails') {
        emails.push(...this.splitMulti(value).map((e) => e.toLowerCase()));
      } else if (field === 'phones') {
        phones.push(
          ...this.splitMulti(value).map((p) => this.normalizePhone(p)),
        );
      } else if ((SCALAR_FIELDS as readonly string[]).includes(field)) {
        // Last non-empty value wins when multiple columns map to one field.
        fields[field] = value;
      }
    }

    return {
      row,
      fields,
      emails: this.uniq(emails),
      phones: this.uniq(phones),
    };
  }

  private splitMulti(value: string): string[] {
    return value
      .split(/[,;]/)
      .map((v) => v.trim())
      .filter(Boolean);
  }

  private normalizePhone(value: string): string {
    // Keep a leading +, strip everything else that isn't a digit.
    const trimmed = value.trim();
    const plus = trimmed.startsWith('+') ? '+' : '';
    return plus + trimmed.replace(/[^0-9]/g, '');
  }

  private uniq(values: string[]): string[] {
    return Array.from(new Set(values.filter(Boolean)));
  }

  // ─────────────────────────── batch processing ───────────────────────────

  private async processBatch(
    batch: MappedRow[],
    data: ContactImportJobData,
    dedupFields: DedupMatchingField[],
    policy: DedupPolicy | undefined,
    claimedKeys: Set<string>,
    summary: ImportSummary,
    report: ImportReportWriter,
    dryRun: boolean,
  ): Promise<void> {
    const errors: ImportRowError[] = [];
    const ops: any[] = [];
    const opMeta: Array<{ row: number; type: 'insert' | 'update' }> = [];
    // _ids touched this batch, for optional automation events post-write.
    const affected: Array<{
      id?: string;
      type: 'insert' | 'update';
      row: number;
    }> = [];

    summary.total += batch.length;

    // ── Validation: firstName + lastName are required (schema-level) ──
    const valid: MappedRow[] = [];
    for (const m of batch) {
      const missing: string[] = [];
      if (!m.fields.firstName) missing.push('firstName');
      if (!m.fields.lastName) missing.push('lastName');
      if (missing.length) {
        summary.errors++;
        errors.push({
          row: m.row,
          field: missing.join(','),
          reason: `Missing required field(s): ${missing.join(', ')}`,
        });
        continue;
      }
      valid.push(m);
    }

    // ── Dedup lookup (one indexed $in query per batch) ──
    const existingByEmail = new Map<string, any>();
    const existingByPhone = new Map<string, any>();
    if (dedupFields.length > 0) {
      const emailVals = dedupFields.includes('emails')
        ? this.uniq(valid.flatMap((m) => m.emails))
        : [];
      const phoneVals = dedupFields.includes('phones')
        ? this.uniq(valid.flatMap((m) => m.phones))
        : [];
      const or: any[] = [];
      if (emailVals.length) or.push({ emails: { $in: emailVals } });
      if (phoneVals.length) or.push({ phones: { $in: phoneVals } });

      if (or.length) {
        const found = await this.contactModel
          .find({
            tenantId: data.tenantId,
            deletedAt: { $exists: false },
            $or: or,
          })
          .select({
            emails: 1,
            phones: 1,
            ...Object.fromEntries(SCALAR_FIELDS.map((f) => [f, 1])),
          })
          .lean()
          .exec();
        for (const doc of found) {
          for (const e of doc.emails ?? []) existingByEmail.set(e, doc);
          for (const p of doc.phones ?? []) existingByPhone.set(p, doc);
        }
      }
    }

    const now = new Date();
    for (const m of valid) {
      const match = this.findMatch(
        m,
        dedupFields,
        existingByEmail,
        existingByPhone,
      );

      if (!match) {
        // Within-file dedup: don't insert two rows sharing a dedup key.
        if (dedupFields.length > 0) {
          const keys = this.dedupKeys(m, dedupFields);
          const clash = keys.find((k) => claimedKeys.has(k));
          if (clash) {
            summary.skipped++;
            errors.push({
              row: m.row,
              reason: 'Skipped: duplicate of an earlier row in the same file',
              value: clash.split(':').slice(1).join(':'),
            });
            continue;
          }
          keys.forEach((k) => claimedKeys.add(k));
        }
        ops.push({ insertOne: { document: this.buildInsert(m, data, now) } });
        opMeta.push({ row: m.row, type: 'insert' });
        summary.inserted++;
        affected.push({ type: 'insert', row: m.row });
        continue;
      }

      // Matched an existing contact → apply the chosen policy.
      if (policy === 'skip') {
        summary.skipped++;
        continue;
      }

      const update =
        policy === 'overwrite'
          ? this.buildOverwrite(m, data)
          : this.buildMerge(m, match, data, errors);

      if (!update) {
        // Merge produced no change (everything already present / all conflicts).
        summary.skipped++;
        continue;
      }

      ops.push({
        updateOne: { filter: { _id: match._id }, update },
      });
      opMeta.push({ row: m.row, type: 'update' });
      summary.updated++;
      affected.push({ type: 'update', id: String(match._id), row: m.row });
    }

    if (dryRun) {
      await report.appendErrors(errors);
      return;
    }

    if (ops.length > 0) {
      const failed = await this.executeBulk(ops, opMeta, errors, summary);
      // Reconcile counts: failed ops never persisted.
      for (const meta of failed) {
        if (meta.type === 'insert') summary.inserted--;
        else summary.updated--;
      }
      // Drop failed inserts from the affected list before emitting automations.
      if (data.triggerAutomations) {
        await this.emitAutomations(affected, ops, opMeta, failed, data);
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
      // w:1 (default) — import does not require majority ack; ordered:false so
      // one bad document doesn't abort the rest of the batch.
      await this.contactModel.bulkWrite(ops, { ordered: false });
    } catch (err: any) {
      const writeErrors: any[] =
        err?.writeErrors ?? err?.result?.writeErrors ?? [];
      if (writeErrors.length === 0) {
        // Whole-batch failure (e.g. connection) — surface and rethrow so the
        // job is marked failed rather than silently reporting success.
        throw err;
      }
      for (const we of writeErrors) {
        const index = we.index ?? we.err?.index;
        const meta = opMeta[index];
        summary.errors++;
        failed.push(meta);
        errors.push({
          row: meta?.row ?? -1,
          reason: `DB write failed: ${we.errmsg ?? we.err?.errmsg ?? 'unknown'}`,
        });
      }
    }
    return failed;
  }

  private findMatch(
    m: MappedRow,
    dedupFields: DedupMatchingField[],
    byEmail: Map<string, any>,
    byPhone: Map<string, any>,
  ): any | null {
    for (const field of dedupFields) {
      const values = field === 'emails' ? m.emails : m.phones;
      const lookup = field === 'emails' ? byEmail : byPhone;
      for (const v of values) {
        const hit = lookup.get(v);
        if (hit) return hit;
      }
    }
    return null;
  }

  private dedupKeys(m: MappedRow, dedupFields: DedupMatchingField[]): string[] {
    const keys: string[] = [];
    if (dedupFields.includes('emails')) {
      m.emails.forEach((e) => keys.push(`email:${e}`));
    }
    if (dedupFields.includes('phones')) {
      m.phones.forEach((p) => keys.push(`phone:${p}`));
    }
    return keys;
  }

  // ─────────────────────────── op builders ───────────────────────────

  private buildInsert(
    m: MappedRow,
    data: ContactImportJobData,
    now: Date,
  ): Record<string, any> {
    return {
      ...m.fields,
      emails: m.emails,
      phones: m.phones,
      tenantId: data.tenantId,
      // createdById / updatedById are required:true in the schema — a batch
      // missing them fails validation entirely.
      createdById: data.userId,
      updatedById: data.userId,
      createdAt: now,
      updatedAt: now,
    };
  }

  private buildOverwrite(
    m: MappedRow,
    data: ContactImportJobData,
  ): Record<string, any> {
    const set: Record<string, any> = {
      ...m.fields,
      updatedById: data.userId,
      updatedAt: new Date(),
    };
    if (m.emails.length) set.emails = m.emails;
    if (m.phones.length) set.phones = m.phones;
    return { $set: set };
  }

  private buildMerge(
    m: MappedRow,
    existing: any,
    data: ContactImportJobData,
    errors: ImportRowError[],
  ): Record<string, any> | null {
    const set: Record<string, any> = {};
    const addToSet: Record<string, any> = {};

    // Scalar fields: fill only when the existing value is empty.
    for (const field of SCALAR_FIELDS) {
      const incoming = m.fields[field];
      if (incoming && !existing[field]) set[field] = incoming;
    }

    this.mergeArray(
      'emails',
      m.emails,
      existing.emails ?? [],
      data.tenantSettings.multipleEmailsAllowed,
      m.row,
      set,
      addToSet,
      errors,
    );
    this.mergeArray(
      'phones',
      m.phones,
      existing.phones ?? [],
      data.tenantSettings.multiplePhonesAllowed,
      m.row,
      set,
      addToSet,
      errors,
    );

    const update: Record<string, any> = {};
    if (Object.keys(set).length) {
      update.$set = { ...set, updatedById: data.userId, updatedAt: new Date() };
    }
    if (Object.keys(addToSet).length) update.$addToSet = addToSet;

    return Object.keys(update).length ? update : null;
  }

  private mergeArray(
    field: 'emails' | 'phones',
    incoming: string[],
    existing: string[],
    multipleAllowed: boolean,
    row: number,
    set: Record<string, any>,
    addToSet: Record<string, any>,
    errors: ImportRowError[],
  ): void {
    if (incoming.length === 0) return;

    if (multipleAllowed) {
      const fresh = incoming.filter((v) => !existing.includes(v));
      if (fresh.length) addToSet[field] = { $each: fresh };
      return;
    }

    // Single-value mode: fill if empty, otherwise warn on a differing value.
    if (existing.length === 0) {
      set[field] = [incoming[0]];
      if (incoming.length > 1) {
        errors.push({
          row,
          field,
          reason: `Only the first ${field} kept (multiple ${field} disabled)`,
          value: incoming.slice(1).join('; '),
        });
      }
      return;
    }

    const conflicting = incoming.filter((v) => !existing.includes(v));
    if (conflicting.length) {
      errors.push({
        row,
        field,
        reason: `Conflict: ${field} differs and multiple ${field} disabled — kept existing`,
        value: conflicting.join('; '),
      });
    }
  }

  // ─────────────────────────── automations (opt-in) ───────────────────────────

  private async emitAutomations(
    affected: Array<{ id?: string; type: 'insert' | 'update'; row: number }>,
    ops: any[],
    opMeta: Array<{ row: number; type: 'insert' | 'update' }>,
    failed: Array<{ row: number; type: 'insert' | 'update' }>,
    data: ContactImportJobData,
  ): Promise<void> {
    const failedRows = new Set(failed.map((f) => f.row));
    for (const a of affected) {
      if (failedRows.has(a.row)) continue;
      const event = a.type === 'insert' ? 'record_created' : 'field_updated';
      this.eventEmitter.emit(buildAutomationEventName(event, 'Contact'), {
        tenantId: data.tenantId,
        event,
        object: 'Contact',
        recordId: a.id,
        data: {},
        automationDepth: 0,
      });
    }
  }

  // ─────────────────────────── helpers ───────────────────────────

  private async reportProgress(
    job: Job<ContactImportJobData>,
    processed: number,
    estimatedTotal?: number,
  ): Promise<void> {
    const total =
      estimatedTotal && estimatedTotal > 0 ? estimatedTotal : undefined;
    const pct = total
      ? Math.min(99, Math.floor((processed / total) * 100))
      : null;
    await job.updateProgress({ processed, total: total ?? null, pct });
    // Update MongoDB progress (batched — this runs once per IMPORT_BATCH_SIZE)
    await this.updateImportJob(String(job.id), {
      progress: { processed, total: total ?? null, pct },
    });
  }

  /** Best-effort update of the MongoDB import job record. */
  private async updateImportJob(
    bullJobId: string,
    update: Record<string, any>,
  ): Promise<void> {
    try {
      await this.importJobModel.updateOne({ bullJobId }, { $set: update });
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
