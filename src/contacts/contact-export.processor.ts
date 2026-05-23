import { Processor } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CONTACT_EXPORT_QUEUE } from './contacts.constants';
import { ContactRepository } from './infrastructure/persistence/document/repositories/contact.repository';
import { ContactExportStorageService } from './contact-export-storage.service';
import {
  BaseTenantConsumer,
  TenantJobData,
} from '../queue/base-tenant.consumer';

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

    const docs = await this.repository.findForExport({ ids, filters });

    this.logger.log(
      `Contact export job ${job.id}: tenantId=${tenantId}, ids=${ids?.length ?? 'all'}, docs=${docs.length}`,
    );

    await job.updateProgress(10);

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

    // ── Push export result to client via WebSocket ──
    this.eventEmitter.emit('contact.export.completed', {
      tenantId,
      userId,
      downloadUrl: exportFile.downloadUrl,
      expiresAt: exportFile.expiresAt,
      recordCount,
      storageKey: exportFile.storageKey,
    });

    this.logger.log(
      `Contact export job ${job.id} completed: ${recordCount} records`,
    );

    return { ...exportFile, recordCount };
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
