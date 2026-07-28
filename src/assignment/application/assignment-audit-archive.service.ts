import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { MetricsService } from '../../observability/metrics.service';
import {
  AssignmentAuditLogDocument,
  AssignmentAuditLogSchemaClass,
} from '../infrastructure/persistence/assignment-audit-log.schema';
import {
  AssignmentAuditArchiveDocument,
  AssignmentAuditArchiveSchemaClass,
} from '../infrastructure/persistence/assignment-audit-archive.schema';

const ARCHIVE_AFTER_MS = 80 * 24 * 60 * 60_000;

@Injectable()
export class AssignmentAuditArchiveService {
  private readonly logger = new Logger(AssignmentAuditArchiveService.name);

  constructor(
    @InjectModel(AssignmentAuditLogSchemaClass.name)
    private readonly hot: Model<AssignmentAuditLogDocument>,
    @InjectModel(AssignmentAuditArchiveSchemaClass.name)
    private readonly archive: Model<AssignmentAuditArchiveDocument>,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async archiveDue(): Promise<number> {
    // @platform-query: global retention sweep; each archived upsert preserves
    // row.tenantId and the update phase is restricted to the exact fetched ids.
    const rows = await this.hot.collection
      .find({
        createdAt: { $lt: new Date(Date.now() - ARCHIVE_AFTER_MS) },
        archivedAt: null,
      })
      .sort({ createdAt: 1, _id: 1 })
      .limit(1000)
      .toArray();
    if (rows.length === 0) return 0;

    const session = await this.hot.db.startSession();
    try {
      await session.withTransaction(async () => {
        await this.archive.collection.bulkWrite(
          rows.map((row) => ({
            updateOne: {
              filter: { tenantId: row.tenantId, sourceAuditId: row._id },
              update: {
                $setOnInsert: {
                  tenantId: row.tenantId,
                  sourceAuditId: row._id,
                  envelope: row,
                  archivedAt: new Date(),
                  createdAt: new Date(),
                  updatedAt: new Date(),
                },
              },
              upsert: true,
            },
          })),
          { ordered: false, session },
        );
        // @platform-query: ids come exclusively from the bounded global sweep
        // above; no caller-controlled ids enter this maintenance operation.
        await this.hot.collection.updateMany(
          { _id: { $in: rows.map((row) => row._id) }, archivedAt: null },
          { $set: { archivedAt: new Date() } },
          { session },
        );
      });
    } finally {
      await session.endSession();
    }
    this.metrics?.incrementCounter(
      'crm_assignment_audit_archived_total',
      {},
      rows.length,
    );
    this.logger.log(`Archived ${rows.length} assignment audit row(s)`);
    return rows.length;
  }
}
