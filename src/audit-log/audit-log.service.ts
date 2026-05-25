import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  AuditLogSchemaClass,
  AuditLogDocument,
} from './entities/audit-log.schema';
import { UserSchemaClass } from '../users/infrastructure/persistence/document/entities/user.schema';

@Injectable()
export class AuditLogService {
  constructor(
    @InjectModel(AuditLogSchemaClass.name, 'audit-log-db-connection')
    private readonly model: Model<AuditLogDocument>,
    @InjectModel(UserSchemaClass.name)
    private readonly userModel: Model<any>,
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

    // ── Populate actor info (batch lookup) ──────────────────────
    const actorIds = [
      ...new Set(
        page
          .map((d: any) => d.actorId)
          .filter((id: string) => id && id !== 'system'),
      ),
    ];

    let actorMap: Record<string, { firstName?: string; lastName?: string; email?: string; photo?: any }> = {};
    if (actorIds.length > 0) {
      try {
        const validIds = actorIds
          .filter((id) => Types.ObjectId.isValid(id))
          .map((id) => new Types.ObjectId(id));

        if (validIds.length > 0) {
          const users = await this.userModel
            .find({ _id: { $in: validIds } }, { firstName: 1, lastName: 1, email: 1, photo: 1 })
            .lean() as Array<{ _id: any; firstName?: string; lastName?: string; email?: string; photo?: any }>;
          for (const u of users) {
            actorMap[u._id.toString()] = {
              firstName: u.firstName,
              lastName: u.lastName,
              email: u.email,
              photo: u.photo,
            };
          }
        }
      } catch {
        // Non-critical — proceed without actor info
      }
    }

    const enriched = page.map((entry: any) => {
      const actor = actorMap[entry.actorId];
      return {
        ...entry,
        _id: entry._id?.toString?.() ?? entry._id,
        actor: actor
          ? {
              name: [actor.firstName, actor.lastName].filter(Boolean).join(' ') || actor.email || null,
              email: actor.email || null,
              photo: actor.photo?.url ?? actor.photo ?? null,
            }
          : entry.actorId === 'system'
            ? { name: 'System', email: null, photo: null }
            : null,
      };
    });

    return { data: enriched, nextCursor, hasMore };
  }
}
