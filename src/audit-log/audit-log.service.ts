import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ClsService } from 'nestjs-cls';
import {
  AuditLogSchemaClass,
  AuditLogSchemaDocument,
} from './entities/audit-log.schema';
import {
  EnhancedAuditLogSchemaClass,
  EnhancedAuditLogDocument,
} from './entities/enhanced-audit-log.schema';

export interface AuditLogRecordInput {
  tenantId?: string;
  action: string;
  targetEntityType: string;
  targetEntityId: string;
  actorId?: string;
  ipAddress?: string;
  userAgent?: string;
  metadata?: Record<string, any>;
}

@Injectable()
export class AuditLogService {
  constructor(
    @InjectModel(AuditLogSchemaClass.name)
    private readonly auditLogModel: Model<AuditLogSchemaDocument>,
    @InjectModel(EnhancedAuditLogSchemaClass.name, 'audit-log-db-connection')
    private readonly enhancedModel: Model<EnhancedAuditLogDocument>,
    private readonly cls: ClsService,
  ) {}

  /**
   * Legacy audit log recording — writes to the old `audit_logs` collection.
   * Kept for backward compatibility with existing `audit.record` events.
   */
  async record(input: AuditLogRecordInput): Promise<void> {
    const tenantId =
      input.tenantId ||
      this.cls.get('activeTenantId') ||
      this.cls.get('tenantId');
    const actorId =
      input.actorId || this.cls.get('userId') || this.cls.get('user.id');

    await this.auditLogModel.create({
      tenantId,
      actorId,
      action: input.action,
      targetEntityType: input.targetEntityType,
      targetEntityId: input.targetEntityId,
      timestamp: new Date(),
      ipAddress: input.ipAddress || this.cls.get('requestIp'),
      userAgent: input.userAgent || this.cls.get('userAgent'),
      metadata: input.metadata,
    });
  }

  /**
   * Cursor-based pagination for enhanced audit logs.
   *
   * Uses composite cursor { t, _id } to handle:
   * - Duplicate millisecond timestamps (common in batch automation)
   * - O(1) performance via compound index (no .skip())
   *
   * [PATCH R1] ObjectId casting ensures index is used correctly.
   */
  async getEnhancedAuditLogs(params: {
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
        // [PATCH R1] Cast _id to ObjectId before comparison.
        // MongoDB stores _id as 12-byte ObjectId — comparing with String
        // causes Index Miss and returns [] which breaks Infinite Scroll.
        const objectId = new Types.ObjectId(_id);
        where.$or = [
          { t: { $lt: new Date(t) } },
          { t: new Date(t), _id: { $lt: objectId } },
        ];
      } catch {
        // Invalid cursor — ignore and return from beginning
      }
    }

    const docs = await this.enhancedModel
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
