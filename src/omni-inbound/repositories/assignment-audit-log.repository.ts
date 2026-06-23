import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  OmniAssignmentAuditLogSchemaClass,
  OmniAssignmentAuditLogDocument,
} from '../infrastructure/persistence/document/entities/assignment-audit-log.schema';

export interface CreateAuditLogDto {
  tenantId: string;
  conversationId: string;
  assignedAgentId: string | null;
  strategy: string;
  reason: string;
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

@Injectable()
export class AssignmentAuditLogRepository {
  constructor(
    @InjectModel(OmniAssignmentAuditLogSchemaClass.name)
    private readonly model: Model<OmniAssignmentAuditLogDocument>,
  ) {}

  async create(dto: CreateAuditLogDto): Promise<void> {
    await this.model.create(dto);
  }

  /**
   * Find audit logs for a tenant, sorted by most recent.
   */
  async findByTenant(
    tenantId: string,
    limit = 50,
  ): Promise<OmniAssignmentAuditLogDocument[]> {
    return this.model
      .find({ tenantId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .exec();
  }

  /**
   * Find audit logs for a specific conversation (chronological order).
   * Primary tool for production routing debugging.
   */
  async findByConversation(
    tenantId: string,
    conversationId: string,
    limit = 20,
  ): Promise<OmniAssignmentAuditLogDocument[]> {
    return this.model
      .find({ tenantId, conversationId })
      .sort({ createdAt: 1 })
      .limit(limit)
      .exec();
  }

  /**
   * Find audit logs for a specific agent.
   */
  async findByAgent(
    tenantId: string,
    agentId: string,
    limit = 50,
  ): Promise<OmniAssignmentAuditLogDocument[]> {
    return this.model
      .find({ tenantId, assignedAgentId: agentId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .exec();
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
  ): Promise<OmniAssignmentAuditLogDocument[]> {
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

    return this.model.find(query).sort({ createdAt: -1 }).limit(limit).exec();
  }
}
