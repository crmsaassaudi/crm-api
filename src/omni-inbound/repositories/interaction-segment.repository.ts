import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { InteractionSegmentSchemaClass } from '../infrastructure/persistence/document/entities/interaction-segment.schema';

export interface InteractionSegmentInput {
  tenantId: string;
  agentId: string;
  type: string;
  refId: string;
  startAt: Date;
  endAt: Date;
  durationMs: number;
  dayKey: string;
}

@Injectable()
export class InteractionSegmentRepository {
  constructor(
    @InjectModel(InteractionSegmentSchemaClass.name)
    private readonly model: Model<InteractionSegmentSchemaClass>,
  ) {}

  async create(seg: InteractionSegmentInput): Promise<void> {
    await this.model.create(seg);
  }

  /** All interaction segments for one agent on one day (optionally one type). */
  async findByAgentAndDay(
    tenantId: string,
    agentId: string,
    dayKey: string,
    type?: string,
  ): Promise<InteractionSegmentSchemaClass[]> {
    return this.model
      .find({ tenantId, agentId, dayKey, ...(type ? { type } : {}) })
      .sort({ startAt: 1 })
      .lean<InteractionSegmentSchemaClass[]>()
      .exec();
  }
}
