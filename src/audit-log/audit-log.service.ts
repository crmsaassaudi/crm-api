import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  AuditLogSchemaClass,
  AuditLogDocument,
} from './entities/audit-log.schema';

@Injectable()
export class AuditLogService {
  constructor(
    @InjectModel(AuditLogSchemaClass.name, 'audit-log-db-connection')
    private readonly model: Model<AuditLogDocument>,
  ) {}

  /**
   * Cursor-based pagination for audit logs.
   *
   * Uses composite cursor { t, _id } to handle:
   * - Duplicate millisecond timestamps (common in batch automation)
   * - O(1) performance via compound index (no .skip())
   */
  async getAuditLogs(params: {
    tenantId: string;
    entityType: string;
    entityId: string;
    limit: number;
    cursor?: string; // base64({ t: ISOString, _id: string })
  }) {
    const { tenantId, entityType, entityId, limit, cursor } = params;
    const where: any = { tenantId, entityType, entityId };

    if (cursor) {
      try {
        const { t, _id } = JSON.parse(
          Buffer.from(cursor, 'base64').toString(),
        );
        const objectId = new Types.ObjectId(_id);
        where.$or = [
          { t: { $lt: new Date(t) } },
          { t: new Date(t), _id: { $lt: objectId } },
        ];
      } catch {
        // Invalid cursor — ignore and return from beginning
      }
    }

    const docs = await this.model
      .find(where)
      .sort({ t: -1, _id: -1 })
      .limit(limit + 1)
      .lean();

    const hasMore = docs.length > limit;
    const page = hasMore ? docs.slice(0, limit) : docs;
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last
        ? Buffer.from(
            JSON.stringify({
              t: last.t instanceof Date ? last.t.toISOString() : last.t,
              _id: last._id.toString(),
            }),
          ).toString('base64')
        : null;

    return { data: page, nextCursor, hasMore };
  }
}


