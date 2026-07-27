import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  AssignmentAuditLogDocument,
  AssignmentAuditLogSchemaClass,
} from './assignment-audit-log.schema';
import {
  AssignmentObjectType,
  AssignmentOutcome,
  AssignmentSource,
} from '../../domain/assignment.types';

export interface WriteAuditEntry {
  tenantId: string;
  objectType: AssignmentObjectType;
  entityId: string;
  assigneeId?: string | null;
  previousAssigneeId?: string | null;
  groupId?: string | null;
  ruleId?: string | null;
  ruleName?: string | null;
  strategy: string;
  outcome: AssignmentOutcome;
  reason: string;
  reasonKey?: string | null;
  reasonParams?: Record<string, any> | null;
  source?: AssignmentSource;
  sourceWorkflowId?: string | null;
  performedByUserId?: string | null;
  channelType?: string | null;
  candidatePoolSize?: number;
  eligiblePoolSize?: number;
  metadata?: Record<string, any>;
}

/** Serialisable form returned by the API. */
export interface AssignmentAuditEntry {
  id: string;
  tenantId: string;
  objectType: AssignmentObjectType;
  entityId: string;
  assigneeId: string | null;
  previousAssigneeId: string | null;
  groupId: string | null;
  ruleId: string | null;
  ruleName: string | null;
  strategy: string;
  outcome: AssignmentOutcome;
  reason: string;
  reasonKey: string | null;
  reasonParams: Record<string, any> | null;
  source: string;
  sourceWorkflowId: string | null;
  performedByUserId: string | null;
  channelType: string | null;
  candidatePoolSize: number;
  eligiblePoolSize: number;
  metadata: Record<string, any>;
  createdAt: string;
}

export interface AuditSearchFilters {
  objectType?: AssignmentObjectType;
  entityId?: string;
  assigneeId?: string;
  outcome?: AssignmentOutcome;
  ruleId?: string;
  source?: AssignmentSource;
}

function toHex(value: any): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value.toHexString === 'function') return value.toHexString();
  return String(value);
}

function toIso(value: any): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return new Date(0).toISOString();
}

@Injectable()
export class AssignmentAuditLogRepository {
  private readonly logger = new Logger(AssignmentAuditLogRepository.name);

  constructor(
    @InjectModel(AssignmentAuditLogSchemaClass.name)
    private readonly model: Model<AssignmentAuditLogDocument>,
  ) {}

  private toDto(doc: any): AssignmentAuditEntry {
    return {
      id: toHex(doc._id) ?? '',
      tenantId: toHex(doc.tenantId) ?? '',
      objectType: doc.objectType,
      entityId: doc.entityId ?? '',
      assigneeId: toHex(doc.assigneeId),
      previousAssigneeId: toHex(doc.previousAssigneeId),
      groupId: toHex(doc.groupId),
      ruleId: doc.ruleId ?? null,
      ruleName: doc.ruleName ?? null,
      strategy: doc.strategy ?? '',
      outcome: doc.outcome,
      reason: doc.reason ?? '',
      reasonKey: doc.reasonKey ?? null,
      reasonParams: doc.reasonParams ?? null,
      source: doc.source ?? 'system',
      sourceWorkflowId: doc.sourceWorkflowId ?? null,
      performedByUserId: toHex(doc.performedByUserId),
      channelType: doc.channelType ?? null,
      candidatePoolSize: doc.candidatePoolSize ?? 0,
      eligiblePoolSize: doc.eligiblePoolSize ?? 0,
      metadata: doc.metadata ?? {},
      createdAt: toIso(doc.createdAt),
    };
  }

  /**
   * Best-effort write. An audit failure must never fail the assignment it is
   * describing — the record is already committed by the time we get here.
   */
  async write(entry: WriteAuditEntry): Promise<void> {
    try {
      await this.model.create({
        ...entry,
        source: entry.source ?? 'system',
        metadata: entry.metadata ?? {},
      });
    } catch (err: any) {
      this.logger.error(
        `Failed to write assignment audit log for ${entry.objectType}/${entry.entityId}: ${err.message}`,
      );
    }
  }

  /** Decision chain for one record — oldest first, which is how it reads. */
  async findByEntity(
    tenantId: string,
    objectType: AssignmentObjectType,
    entityId: string,
    limit = 50,
  ): Promise<AssignmentAuditEntry[]> {
    const docs = await this.model
      .find({ tenantId, objectType, entityId })
      .sort({ createdAt: 1 })
      .limit(limit)
      .lean()
      .exec();
    return docs.map((d) => this.toDto(d));
  }

  /**
   * Newest-first page for one record, with a `createdAt` cursor.
   * Kept separate from findByEntity because the conversation trace panel pages
   * backwards from the latest decision.
   */
  async pageByEntity(
    tenantId: string,
    objectType: AssignmentObjectType,
    entityId: string,
    limit = 10,
    cursor?: string,
  ): Promise<{ entries: AssignmentAuditEntry[]; nextCursor: string | null }> {
    const query: Record<string, any> = { tenantId, objectType, entityId };
    if (cursor) query.createdAt = { $lt: new Date(cursor) };

    const docs = await this.model
      .find(query)
      .sort({ createdAt: -1 })
      .limit(limit + 1)
      .lean()
      .exec();

    const hasMore = docs.length > limit;
    if (hasMore) docs.pop();

    const entries = docs.map((d) => this.toDto(d));
    return {
      entries,
      nextCursor: hasMore ? entries[entries.length - 1].createdAt : null,
    };
  }

  async search(
    tenantId: string,
    filters: AuditSearchFilters,
    limit = 50,
  ): Promise<AssignmentAuditEntry[]> {
    const query: Record<string, any> = { tenantId };
    if (filters.objectType) query.objectType = filters.objectType;
    if (filters.outcome) query.outcome = filters.outcome;
    if (filters.ruleId) query.ruleId = filters.ruleId;
    if (filters.source) query.source = filters.source;
    if (filters.entityId) {
      // entityId is a plain string here (it can be 'pre-create'), so an exact
      // match is safe and no ObjectId cast can throw.
      query.entityId = filters.entityId;
    }
    if (filters.assigneeId) {
      // assigneeId IS an ObjectId — an invalid string would throw a CastError,
      // so reject it here rather than 500 on a partial id from a search box.
      if (!Types.ObjectId.isValid(filters.assigneeId)) return [];
      query.assigneeId = filters.assigneeId;
    }

    const docs = await this.model
      .find(query)
      .sort({ createdAt: -1 })
      .limit(Math.min(limit, 200))
      .lean()
      .exec();
    return docs.map((d) => this.toDto(d));
  }
}
