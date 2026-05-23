import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CONTACT_EXPORT_QUEUE } from './contacts.constants';
import { ContactRepository } from './infrastructure/persistence/document/repositories/contact.repository';
import { ContactExportStorageService } from './contact-export-storage.service';
import { runWithTenantContext } from '../common/tenancy/tenant-context';

export interface ContactExportJobData {
  tenantId: string;
  userId?: string;
  ids?: string[];
  filters?: any;
}

@Processor(CONTACT_EXPORT_QUEUE)
export class ContactExportProcessor extends WorkerHost {
  private readonly logger = new Logger(ContactExportProcessor.name);

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
    private readonly cls: ClsService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    super();
  }

  async process(job: Job<ContactExportJobData>): Promise<{
    downloadUrl: string;
    expiresAt: string;
    recordCount: number;
    storageKey: string;
  }> {
    const { tenantId, userId, ids, filters } = job.data;

    return runWithTenantContext(this.cls, tenantId, async () => {
      if (userId) {
        this.cls.set('userId', userId);
      }

      // ── Query documents INSIDE the CLS context ──
      // This guarantees the Mongoose tenant-filter plugin can read
      // activeTenantId from CLS. Previously an async generator was
      // consumed by stream pipeline() which could lose the CLS store.
      const docs = await this.repository.findForExport({
        ids,
        filters,
      });

      this.logger.log(
        `Contact export job ${job.id}: tenantId=${tenantId}, ids=${ids?.length ?? 'all'}, docs=${docs.length}`,
      );

      await job.updateProgress(10);

      // ── Build CSV string in memory ──
      const csvContent = this.buildCsv(docs);
      const recordCount = docs.length;

      await job.updateProgress(80);

      const exportFile = await this.storageService.storeCsv(
        csvContent,
        `contacts-export-${new Date().toISOString().slice(0, 10)}.csv`,
        5 * 60,
      );

      await job.updateProgress(100);

      this.eventEmitter.emit('activity.create', {
        tenantId,
        actorId: userId,
        targetType: 'contact',
        targetId: 'export',
        event: 'export',
        payload: { recordCount, ids, filters },
      });
      this.eventEmitter.emit('audit.record', {
        tenantId,
        actorId: userId,
        action: 'CONTACTS_EXPORTED',
        targetEntityType: 'Contact',
        targetEntityId: 'export',
        metadata: {
          recordCount,
          ids,
          filters,
          storageKey: exportFile.storageKey,
          expiresAt: exportFile.expiresAt,
        },
      });

      this.logger.log(
        `Contact export job ${job.id} completed: ${recordCount} records`,
      );

      return { ...exportFile, recordCount };
    });
  }

  private buildCsv(docs: any[]): string {
    const lines: string[] = [];

    // Header row
    lines.push(this.CSV_HEADERS.join(','));

    // Data rows
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

