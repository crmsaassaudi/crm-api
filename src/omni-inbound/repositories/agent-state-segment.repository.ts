import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AgentStateSegmentSchemaClass } from '../infrastructure/persistence/document/entities/agent-state-segment.schema';

export interface AgentStateSegmentInput {
  tenantId: string;
  agentId: string;
  axis: string;
  value: string;
  startAt: Date;
  endAt: Date;
  durationMs: number;
  dayKey: string;
  trigger?: string;
}

@Injectable()
export class AgentStateSegmentRepository {
  constructor(
    @InjectModel(AgentStateSegmentSchemaClass.name)
    private readonly model: Model<AgentStateSegmentSchemaClass>,
  ) {}

  async createMany(segments: AgentStateSegmentInput[]): Promise<void> {
    if (segments.length === 0) return;
    // ordered:false so one bad doc never blocks the rest of the batch.
    await this.model.insertMany(segments, { ordered: false });
  }

  /**
   * All segments for one agent on one day, optionally for a single axis.
   * Sorted chronologically.
   */
  async findByAgentAndDay(
    tenantId: string,
    agentId: string,
    dayKey: string,
    axis?: string,
  ): Promise<AgentStateSegmentSchemaClass[]> {
    return this.model
      .find({ tenantId, agentId, dayKey, ...(axis ? { axis } : {}) })
      .sort({ startAt: 1 })
      .lean<AgentStateSegmentSchemaClass[]>()
      .exec();
  }

  /** All segments for a tenant on a day (team report). */
  async findByTenantAndDay(
    tenantId: string,
    dayKey: string,
    axis?: string,
  ): Promise<AgentStateSegmentSchemaClass[]> {
    return this.model
      .find({ tenantId, dayKey, ...(axis ? { axis } : {}) })
      .sort({ agentId: 1, startAt: 1 })
      .lean<AgentStateSegmentSchemaClass[]>()
      .exec();
  }
}
