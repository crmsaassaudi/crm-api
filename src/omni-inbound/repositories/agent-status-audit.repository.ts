import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AgentStatusAuditLogSchemaClass } from '../infrastructure/persistence/document/entities/agent-status-audit-log.schema';

export interface CreateStatusAuditLogDto {
  tenantId: string;
  agentId: string;
  fromStatus: string;
  toStatus: string;
  trigger: string;
  timestamp: Date;
  metadata?: Record<string, any>;
}

export interface StatusAuditLogEntry {
  tenantId: string;
  agentId: string;
  fromStatus: string;
  toStatus: string;
  trigger: string;
  timestamp: Date;
  metadata?: Record<string, any>;
}

@Injectable()
export class AgentStatusAuditRepository {
  constructor(
    @InjectModel(AgentStatusAuditLogSchemaClass.name)
    private readonly model: Model<AgentStatusAuditLogSchemaClass>,
  ) {}

  async create(dto: CreateStatusAuditLogDto): Promise<void> {
    await this.model.create(dto);
  }

  /**
   * Find all status transitions for an agent within a date range.
   * Sorted by timestamp ascending (chronological order).
   */
  async findByAgentAndDateRange(
    tenantId: string,
    agentId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<StatusAuditLogEntry[]> {
    return this.model
      .find({
        tenantId,
        agentId,
        timestamp: { $gte: startDate, $lte: endDate },
      })
      .sort({ timestamp: 1 })
      .lean<StatusAuditLogEntry[]>()
      .exec();
  }

  /**
   * Find all status transitions for all agents in a tenant within a date range.
   */
  async findByTenantAndDateRange(
    tenantId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<StatusAuditLogEntry[]> {
    return this.model
      .find({
        tenantId,
        timestamp: { $gte: startDate, $lte: endDate },
      })
      .sort({ agentId: 1, timestamp: 1 })
      .lean<StatusAuditLogEntry[]>()
      .exec();
  }
}
