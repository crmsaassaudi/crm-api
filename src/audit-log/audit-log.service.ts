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
        const { t, _id } = JSON.parse(Buffer.from(cursor, 'base64').toString());
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

    // ── Populate actor and referenced user info (batch lookup) ──────────────────────
    const actorIds = page
      .map((d: any) => d.actorId)
      .filter((id: string) => id && id !== 'system');

    const referencedUserIds: string[] = [];
    for (const entry of page) {
      if (entry.changes && Array.isArray(entry.changes)) {
        for (const change of entry.changes) {
          if (change.f === 'ownerId' || change.f === 'assigneeId') {
            if (
              change.o &&
              typeof change.o === 'string' &&
              change.o !== 'system'
            ) {
              referencedUserIds.push(change.o);
            }
            if (
              change.n &&
              typeof change.n === 'string' &&
              change.n !== 'system'
            ) {
              referencedUserIds.push(change.n);
            }
          }
        }
      }
    }

    const allUserIds = [...actorIds, ...referencedUserIds].filter(
      (value, index, self) => self.indexOf(value) === index,
    );

    const userMap: Record<
      string,
      { firstName?: string; lastName?: string; email?: string; photo?: any }
    > = {};
    if (allUserIds.length > 0) {
      try {
        const validIds = allUserIds
          .filter((id) => Types.ObjectId.isValid(id as string))
          .map((id) => new Types.ObjectId(id as string));

        if (validIds.length > 0) {
          const users = (await this.userModel
            .find(
              { _id: { $in: validIds } },
              { firstName: 1, lastName: 1, email: 1, photo: 1 },
            )
            .lean()) as Array<{
            _id: any;
            firstName?: string;
            lastName?: string;
            email?: string;
            photo?: any;
          }>;

          for (const u of users) {
            userMap[u._id.toString()] = {
              firstName: u.firstName,
              lastName: u.lastName,
              email: u.email,
              photo: u.photo,
            };
          }
        }
      } catch (err) {
        console.error('[AuditLogService] User lookup failed:', err?.message);
      }
    }

    const enriched = page.map((entry: any) => {
      const actor = userMap[entry.actorId];
      // Destructure to separate _id and __v from rest to avoid ObjectId serialization issues
      const { _id, __v: _ignored, changes, ...rest } = entry;
      const idStr = typeof _id === 'string' ? _id : String(_id);

      const enrichedChanges = (changes || []).map((change: any) => {
        if (change.f === 'ownerId' || change.f === 'assigneeId') {
          const oldUser = change.o ? userMap[String(change.o)] : null;
          const newUser = change.n ? userMap[String(change.n)] : null;

          return {
            ...change,
            o: oldUser
              ? [oldUser.firstName, oldUser.lastName]
                  .filter(Boolean)
                  .join(' ') || oldUser.email
              : change.o,
            n: newUser
              ? [newUser.firstName, newUser.lastName]
                  .filter(Boolean)
                  .join(' ') || newUser.email
              : change.n,
          };
        }
        return change;
      });

      return {
        ...rest,
        _id: idStr,
        changes: enrichedChanges,
        actor: actor
          ? {
              name:
                [actor.firstName, actor.lastName].filter(Boolean).join(' ') ||
                actor.email ||
                null,
              email: actor.email || null,
              photo: actor.photo?.url ?? actor.photo ?? null,
            }
          : entry.actorId === 'system'
            ? { name: 'System', email: null, photo: null }
            : { name: null, email: null, photo: null },
      };
    });

    return { data: enriched, nextCursor, hasMore };
  }
}
