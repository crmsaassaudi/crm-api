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
   * Supports filters: conversationId (partial match), outcome, agentId.
   * Returns newest-first for the global history page.
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
      // Support partial ID matching (user may paste partial IDs)
      query.conversationId = new RegExp(filters.conversationId, 'i');
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
