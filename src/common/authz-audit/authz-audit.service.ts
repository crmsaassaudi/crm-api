import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ClsService } from 'nestjs-cls';
import { MetricsService } from '../../observability/metrics.service';
import {
  AuthzAuditLogSchemaClass,
  AuthzAuditLogDocument,
  AuthzAuditCategory,
  AuthzAuditAction,
} from './authz-audit-log.schema';

export interface AuthzAuditEntry {
  category: AuthzAuditCategory;
  action: AuthzAuditAction;
  targetType: string;
  targetId: string;
  summary?: string;
  before?: any;
  after?: any;
  /** Override tenant/actor when not derivable from CLS (rare, e.g. jobs). */
  tenantId?: string;
  actorId?: string;
}

/**
 * AuthzAuditService — records immutable authorization-governance events.
 *
 * `record()` is fire-and-forget and MUST NOT throw or block the caller: an
 * audit-write failure can never break the authorization change it describes.
 * Actor / tenant / ip are resolved from CLS unless explicitly provided.
 */
@Injectable()
export class AuthzAuditService {
  private readonly logger = new Logger(AuthzAuditService.name);

  constructor(
    @InjectModel(AuthzAuditLogSchemaClass.name)
    private readonly model: Model<AuthzAuditLogDocument>,
    private readonly cls: ClsService,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  async record(entry: AuthzAuditEntry): Promise<void> {
    let tenantId: string | null = null;
    try {
      tenantId = entry.tenantId ?? this.cls.get<string>('tenantId') ?? null;
      const actorId =
        entry.actorId ?? this.cls.get<string>('userId') ?? 'system';
      if (!tenantId) {
        // No tenant context → nothing meaningful to scope. This is a
        // programming/context error for a governance event, so surface it.
        this.metrics?.incrementCounter('crm_authz_audit_dropped_total', {
          reason: 'no_tenant',
          category: entry.category,
        });
        this.logger.error(
          `Authz audit entry dropped — no tenant context (${entry.category}/${entry.action} ${entry.targetType}/${entry.targetId})`,
        );
        return;
      }

      await this.model.create({
        tenantId: String(tenantId),
        actorId: String(actorId),
        actorEmail: this.cls.get<string>('email') ?? null,
        actorType: this.cls.get<string>('principalType') ?? 'user',
        category: entry.category,
        action: entry.action,
        targetType: entry.targetType,
        targetId: String(entry.targetId),
        summary: entry.summary ?? null,
        before: entry.before ?? null,
        after: entry.after ?? null,
        ip: this.cls.get<string>('ip') ?? null,
      });

      this.metrics?.incrementCounter('crm_authz_audit_written_total', {
        category: entry.category,
        action: entry.action,
      });
    } catch (error) {
      // NEVER rethrow — an audit failure must not break the authz change it
      // describes. But it MUST be loud: escalate to error + a counter so the
      // gap is alertable rather than silently swallowed.
      this.metrics?.incrementCounter('crm_authz_audit_failed_total', {
        category: entry.category,
        action: entry.action,
      });
      this.logger.error(
        `FAILED to persist authz audit entry (${entry.category}/${entry.action} ${entry.targetType}/${entry.targetId}) tenant=${tenantId ?? 'unknown'}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  /** Cursor-paginated read, newest-first, scoped to a tenant. */
  async query(params: {
    tenantId: string;
    category?: AuthzAuditCategory;
    targetType?: string;
    targetId?: string;
    limit?: number;
    cursor?: string; // base64 { t, _id }
  }) {
    const limit = Math.min(Math.max(params.limit ?? 25, 1), 100);
    const where: any = { tenantId: params.tenantId };
    if (params.category) where.category = params.category;
    if (params.targetType) where.targetType = params.targetType;
    if (params.targetId) where.targetId = params.targetId;
    this.applyCursor(where, params.cursor);

    const docs = await this.model
      .find(where)
      .sort({ t: -1, _id: -1 })
      .limit(limit + 1)
      .lean();

    const hasMore = docs.length > limit;
    const page = hasMore ? docs.slice(0, limit) : docs;
    const last: any = page[page.length - 1];
    const nextCursor =
      hasMore && last
        ? Buffer.from(
            JSON.stringify({ t: last.t, _id: String(last._id) }),
          ).toString('base64')
        : null;

    return { data: page, nextCursor, hasMore };
  }

  private applyCursor(where: any, cursor?: string): void {
    if (!cursor) return;
    try {
      const { t, _id } = JSON.parse(Buffer.from(cursor, 'base64').toString());
      where.$or = [
        { t: { $lt: new Date(t) } },
        { t: new Date(t), _id: { $lt: Types.ObjectId.createFromHexString(_id) } },
      ];
    } catch {
      // invalid cursor → start from newest
    }
  }
}
