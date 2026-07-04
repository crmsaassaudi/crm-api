import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  OmniAssignmentAuditLogSchemaClass,
  OmniAssignmentAuditLogDocument,
} from '../infrastructure/persistence/document/entities/omni-assignment-audit-log.schema';

export interface CreateAuditLogDto {
  tenantId: string;
  conversationId: string;
  assignedAgentId: string | null;
  strategy: string;
  reason: string;
  /** i18n key — e.g. 'noAgentsQueued'. Maps to routingTrace.reason.<key> in locale files. */
  reasonKey?: string | null;
  /** Interpolation params for the reasonKey — e.g. { minutes: 30 } */
  reasonParams?: Record<string, any> | null;
  metadata?: Record<string, any>;
  outcome: 'assigned' | 'queued' | 'failed';
  // T05: structured audit fields (previously buried in metadata blob)
  /** Agent who was assigned before this decision (null = first assignment) */
  previousAgentId?: string | null;
  /** Routing rule that matched and drove this assignment (null = default strategy) */
  ruleId?: string | null;
  /** Human-readable routing rule name for dashboards */
  ruleName?: string | null;
  /** Channel type for per-channel routing analytics */
  channelType?: string | null;
  /** Total agent pool size before skills filtering */
  agentPoolSize?: number;
  /** Agent pool size after skills filtering */
  eligiblePoolSize?: number;
}

/**
 * Clean serializable representation of an audit log entry returned by the API.
 * All ObjectId fields are normalized to hex strings.
 * Dates are serialized as ISO 8601 strings.
 */
export interface AuditLogEntry {
  id: string;
  tenantId: string;
  conversationId: string;
  assignedAgentId: string | null;
  previousAgentId: string | null;
  ruleId: string | null;
  ruleName: string | null;
  channelType: string | null;
  agentPoolSize: number;
  eligiblePoolSize: number;
  strategy: string;
  reason: string;
  /** i18n key for the reason — use this on the frontend to translate. Null for legacy entries. */
  reasonKey: string | null;
  /** Interpolation params to pass to t(reasonKey, reasonParams). */
  reasonParams: Record<string, any> | null;
  metadata: Record<string, any>;
  outcome: 'assigned' | 'queued' | 'failed';
  createdAt: string;
  updatedAt: string;
}

@Injectable()
export class AssignmentAuditLogRepository {
  constructor(
    @InjectModel(OmniAssignmentAuditLogSchemaClass.name)
    private readonly model: Model<OmniAssignmentAuditLogDocument>,
  ) {}

  /**
   * Convert a raw lean MongoDB document to a clean serializable AuditLogEntry.
   *
   * .lean() returns ObjectId instances (not strings) for fields typed as
   * MongooseSchema.Types.ObjectId. Without this mapper the API response
   * contains buffer bytes or "[object Object]" instead of hex strings.
   */
  private toDto(doc: Record<string, any>): AuditLogEntry {
    const toHex = (v: any): string | null => {
      if (v == null) return null;
      if (typeof v === 'string') return v;
      if (typeof v.toHexString === 'function') return v.toHexString();
      return String(v);
    };

    const toIso = (v: any): string | null => {
      if (v == null) return null;
      if (v instanceof Date) return v.toISOString();
      if (typeof v === 'string') return v;
      return null;
    };

    return {
      id: toHex(doc._id) ?? '',
      tenantId: toHex(doc.tenantId) ?? '',
      conversationId: toHex(doc.conversationId) ?? '',
      assignedAgentId: toHex(doc.assignedAgentId),
      previousAgentId: toHex(doc.previousAgentId),
      ruleId: doc.ruleId ?? null,
      ruleName: doc.ruleName ?? null,
      channelType: doc.channelType ?? null,
      agentPoolSize: doc.agentPoolSize ?? 0,
      eligiblePoolSize: doc.eligiblePoolSize ?? 0,
      strategy: doc.strategy ?? '',
      reason: doc.reason ?? '',
      reasonKey: doc.reasonKey ?? null,
      reasonParams: doc.reasonParams ?? null,
      metadata: doc.metadata ?? {},
      outcome: doc.outcome,
      createdAt: toIso(doc.createdAt) as any,
      updatedAt: toIso(doc.updatedAt) as any,
    };
  }

  async create(dto: CreateAuditLogDto): Promise<void> {
    await this.model.create(dto);
  }

  /**
   * Find audit logs for a tenant, sorted by most recent.
   */
  async findByTenant(tenantId: string, limit = 50): Promise<AuditLogEntry[]> {
    const docs = await this.model
      .find({ tenantId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean()
      .exec();
    return docs.map(this.toDto);
  }

  /**
   * Find audit logs for a specific conversation — newest first.
   * Supports cursor-based pagination: pass the `createdAt` ISO string of the
   * last entry received to get the next page (entries older than that cursor).
   */
  async findByConversation(
    tenantId: string,
    conversationId: string,
    limit = 10,
    cursor?: string, // ISO timestamp — fetch entries older than this
  ): Promise<{ entries: AuditLogEntry[]; nextCursor: string | null }> {
    const query: Record<string, any> = { tenantId, conversationId };
    if (cursor) {
      // Cursor = createdAt of the last entry seen — fetch everything strictly older
      query.createdAt = { $lt: new Date(cursor) };
    }

    const docs = await this.model
      .find(query)
      .sort({ createdAt: -1 }) // newest first
      .limit(limit + 1) // fetch one extra to detect hasMore
      .lean()
      .exec();

    const hasMore = docs.length > limit;
    if (hasMore) docs.pop(); // remove the extra sentinel doc

    const entries = docs.map((d) => this.toDto(d));
    const nextCursor = hasMore
      ? entries[entries.length - 1].createdAt // ISO string of oldest in page
      : null;

    return { entries, nextCursor };
  }

  /**
   * Find audit logs for a specific agent.
   */
  async findByAgent(
    tenantId: string,
    agentId: string,
    limit = 50,
  ): Promise<AuditLogEntry[]> {
    const docs = await this.model
      .find({ tenantId, assignedAgentId: agentId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean()
      .exec();
    return docs.map(this.toDto);
  }

  /**
   * Global search across all audit logs for a tenant.
   * Supports filters: conversationId (exact ObjectId match), outcome, agentId.
   * Returns newest-first for the global history page.
   *
   * NOTE: conversationId is stored as an ObjectId in MongoDB — partial string
   * matching via RegExp throws a CastError at query time. If the provided
   * conversationId is not a valid 24-hex-char ObjectId, returns [] immediately.
   */
  async search(
    tenantId: string,
    filters: {
      conversationId?: string;
      outcome?: 'assigned' | 'queued' | 'failed';
      agentId?: string;
    },
    limit = 50,
  ): Promise<AuditLogEntry[]> {
    const query: Record<string, any> = { tenantId };

    if (filters.conversationId) {
      // ObjectId fields cannot be queried with RegExp — that throws a CastError.
      // Only search if the caller supplied a valid 24-hex-char ObjectId string.
      if (!/^[a-f\d]{24}$/i.test(filters.conversationId)) {
        return []; // Partial/invalid ID — return empty rather than crash.
      }
      query.conversationId = filters.conversationId;
    }
    if (filters.outcome) {
      query.outcome = filters.outcome;
    }
    if (filters.agentId) {
      query.assignedAgentId = filters.agentId;
    }

    const docs = await this.model
      .find(query)
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean()
      .exec();
    return docs.map(this.toDto);
  }
}
