import { Processor } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import Redis from 'ioredis';
import { CONTACT_EXPORT_QUEUE } from './contacts.constants';
import { ContactRepository } from './infrastructure/persistence/document/repositories/contact.repository';
import { ContactExportStorageService } from './contact-export-storage.service';
import {
  BaseTenantConsumer,
  TenantJobData,
} from '../queue/base-tenant.consumer';
import { IOREDIS_CLIENT } from '../redis/redis.tokens';

export interface ContactExportJobData extends TenantJobData {
  ids?: string[];
  filters?: any;
}

@Processor(CONTACT_EXPORT_QUEUE)
export class ContactExportProcessor extends BaseTenantConsumer<ContactExportJobData> {
  protected readonly logger = new Logger(ContactExportProcessor.name);
  protected readonly cls: ClsService;

  private readonly CSV_HEADERS = [
    'id',
    'firstName',
    'lastName',
    'emails',
    'phones',
    'companyName',
    'title',
    'lifecycleStageId',
    'statusId',
    'lastActivityAt',
  ] as const;

  constructor(
    private readonly repository: ContactRepository,
    private readonly storageService: ContactExportStorageService,
    cls: ClsService,
    private readonly eventEmitter: EventEmitter2,
    @Inject(IOREDIS_CLIENT) private readonly redis: Redis,
  ) {
    super();
    this.cls = cls;
  }

  protected async handle(job: Job<ContactExportJobData>): Promise<{
    downloadUrl: string;
    expiresAt: string;
    recordCount: number;
    storageKey: string;
  }> {
    const { tenantId, userId, ids, filters } = job.data;

    // Stream documents instead of loading all into memory to prevent OOM
    const stream = this.repository.streamForExport({ ids, filters });

    const lines: string[] = [this.CSV_HEADERS.join(',')];
    let recordCount = 0;

    for await (const doc of stream) {
      const row = this.CSV_HEADERS.map((key) =>
        this.csvCell(this.getValue(doc, key)),
      ).join(',');
      lines.push(row);
      recordCount++;

      // Report progress periodically
      if (recordCount % 500 === 0) {
        await job.updateProgress(
          Math.min(
            80,
            Math.floor((recordCount / Math.max(recordCount + 100, 1)) * 80),
          ),
        );
      }
    }

    this.logger.log(
      `Contact export job ${job.id}: tenantId=${tenantId}, ids=${ids?.length ?? 'all'}, docs=${recordCount}`,
    );

    await job.updateProgress(80);

    const csvContent = lines.join('\n') + '\n';

    const exportFile = await this.storageService.storeCsv(
      csvContent,
      `contacts-export-${new Date().toISOString().slice(0, 10)}.csv`,
      5 * 60,
    );

    await job.updateProgress(100);

    // Export is a system action — not written to Activity Log.

    // ── Push export result to client via Redis pub/sub ──
    // Worker process cannot emit Socket.IO events directly (no WS server).
    // Publish to Redis channel → API process subscribes and broadcasts via OmniGateway.
    await this.redis.publish(
      'socket:contact:export:completed',
      JSON.stringify({
        tenantId,
        userId,
        downloadUrl: exportFile.downloadUrl,
        expiresAt: exportFile.expiresAt,
        recordCount,
      }),
    );

    this.logger.log(
      `Contact export job ${job.id} completed: ${recordCount} records`,
    );

    return { ...exportFile, recordCount, storageKey: exportFile.storageKey };
  }

  private buildCsv(docs: any[]): string {
    const lines: string[] = [];
    lines.push(this.CSV_HEADERS.join(','));

    for (const doc of docs) {
      const row = this.CSV_HEADERS.map((key) =>
        this.csvCell(this.getValue(doc, key)),
      ).join(',');
      lines.push(row);
    }

    return lines.join('\n') + '\n';
  }

  private getValue(doc: any, key: string): any {
    if (key === 'id') {
      return doc._id?.toString?.() ?? doc.id;
    }
    return typeof doc.get === 'function' ? doc.get(key) : doc[key];
  }

  private csvCell(value: any): string {
    const normalized = Array.isArray(value)
      ? value.join('; ')
      : value instanceof Date
        ? value.toISOString()
        : value == null
          ? ''
          : String(value);
    return `"${normalized.replace(/"/g, '""')}"`;
  }
}
