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

      const totalCount = await this.repository.countForExport({ ids, filters });
      let recordCount = 0;
      const rows = this.createCsvRows(job, totalCount, () => {
        recordCount += 1;
      });

      const exportFile = await this.storageService.storeCsvStream(
        rows,
        `contacts-export-${new Date().toISOString().slice(0, 10)}.csv`,
        5 * 60,
      );

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

      return { ...exportFile, recordCount };
    });
  }

  private async *createCsvRows(
    job: Job<ContactExportJobData>,
    totalCount: number,
    onRecord: () => void,
  ): AsyncIterable<string> {
    const header = [
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
    ];
    yield `${header.join(',')}\n`;

    const cursor = this.repository.streamForExport({
      ids: job.data.ids,
      filters: job.data.filters,
    });
    let processed = 0;

    for await (const doc of cursor) {
      processed += 1;
      onRecord();
      const row = header
        .map((key) => this.csvCell(this.getValue(doc, key)))
        .join(',');
      yield `${row}\n`;

      if (processed % 500 === 0) {
        await job.updateProgress(
          totalCount > 0
            ? Math.min(99, Math.floor((processed / totalCount) * 100))
            : 0,
        );
      }
    }

    await job.updateProgress(100);
    this.logger.log(`Contact export job ${job.id} wrote ${processed} records`);
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
