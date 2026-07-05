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
    this.applyCursorFilter(where, cursor);

    const docs = await this.model
      .find(where)
      .sort({ t: -1, _id: -1 })
      .limit(limit + 1)
      .lean();

    const hasMore = docs.length > limit;
    const page = hasMore ? docs.slice(0, limit) : docs;
    const last = page[page.length - 1];
    const nextCursor = this.buildNextCursor(hasMore, last);

    const userMap = await this.buildUserMap(page);

    const enriched = page.map((entry: any) => this.enrichEntry(entry, userMap));
    return { data: enriched, nextCursor, hasMore };
  }

  /** Apply a composite cursor constraint ({ t, _id }) to the Mongoose filter in-place. */
  private applyCursorFilter(where: any, cursor: string | undefined): void {
    if (!cursor) return;
    try {
      const { t, _id } = JSON.parse(Buffer.from(cursor, 'base64').toString());
      const objectId = Types.ObjectId.createFromHexString(_id);
      where.$or = [
        { t: { $lt: new Date(t) } },
        { t: new Date(t), _id: { $lt: objectId } },
      ];
    } catch {
      // Invalid cursor — ignore and return from beginning
    }
  }

  /** Build the opaque next-page cursor from the last page entry. */
  private buildNextCursor(hasMore: boolean, last: any): string | null {
    if (!hasMore || !last) return null;
    return Buffer.from(
      JSON.stringify({
        t: last.t instanceof Date ? last.t.toISOString() : last.t,
        _id: last._id.toString(),
      }),
    ).toString('base64');
  }

  /** Batch-load all actor + referenced-user data needed for a page of entries. */
  private async buildUserMap(
    page: any[],
  ): Promise<
    Record<
      string,
      { firstName?: string; lastName?: string; email?: string; photo?: any }
    >
  > {
    const actorIds = page
      .map((d: any) => d.actorId)
      .filter((id: string) => id && id !== 'system');

    const referencedUserIds = this.collectReferencedUserIds(page);

    const allUserIds = [...new Set([...actorIds, ...referencedUserIds])];
    return this.fetchUsers(allUserIds);
  }

  /** Collect ObjectId values from ownerId / assigneeId change entries. */
  private collectReferencedUserIds(page: any[]): string[] {
    const ids: string[] = [];
    for (const entry of page) {
      if (!Array.isArray(entry.changes)) continue;
      for (const change of entry.changes) {
        if (change.f !== 'ownerId' && change.f !== 'assigneeId') continue;
        if (change.o && typeof change.o === 'string' && change.o !== 'system') {
          ids.push(change.o);
        }
        if (change.n && typeof change.n === 'string' && change.n !== 'system') {
          ids.push(change.n);
        }
      }
    }
    return ids;
  }

  /** Resolve a list of user IDs to a firstName/lastName/email/photo map. */
  private async fetchUsers(
    allUserIds: string[],
  ): Promise<
    Record<
      string,
      { firstName?: string; lastName?: string; email?: string; photo?: any }
    >
  > {
    const userMap: Record<string, any> = {};
    if (allUserIds.length === 0) return userMap;
    try {
      const validIds = allUserIds
        .filter((id) => Types.ObjectId.isValid(id))
        .map((id) => new Types.ObjectId(id));
      if (validIds.length === 0) return userMap;
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
    } catch (err: any) {
      console.error('[AuditLogService] User lookup failed:', err?.message);
    }
    return userMap;
  }

  /** Enrich a single audit log entry with resolved actor and user-reference data. */
  private enrichEntry(entry: any, userMap: Record<string, any>): any {
    const actor = userMap[entry.actorId];
    const { _id, __v: _ignored, changes, ...rest } = entry;
    const idStr = typeof _id === 'string' ? _id : String(_id);
    const enrichedChanges = this.enrichChanges(changes ?? [], userMap);
    const actorShape = this.resolveActorShape(actor, entry.actorId);
    return { ...rest, _id: idStr, changes: enrichedChanges, actor: actorShape };
  }

  /** Map change entries so ownerId / assigneeId values show display names. */
  private enrichChanges(changes: any[], userMap: Record<string, any>): any[] {
    return changes.map((change) => {
      if (change.f !== 'ownerId' && change.f !== 'assigneeId') return change;
      const displayName = (u: any) =>
        u
          ? [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email
          : null;
      return {
        ...change,
        o: displayName(change.o ? userMap[String(change.o)] : null) ?? change.o,
        n: displayName(change.n ? userMap[String(change.n)] : null) ?? change.n,
      };
    });
  }

  /** Resolve the actor shape for a log entry. */
  private resolveActorShape(
    actor: any,
    actorId: string,
  ): { name: string | null; email: string | null; photo: any } {
    if (actor) {
      return {
        name:
          [actor.firstName, actor.lastName].filter(Boolean).join(' ') ||
          actor.email ||
          null,
        email: actor.email ?? null,
        photo: actor.photo?.url ?? actor.photo ?? null,
      };
    }
    if (actorId === 'system') {
      return { name: 'System', email: null, photo: null };
    }
    return { name: null, email: null, photo: null };
  }
}
