import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';

export type AgentStateSegmentDocument =
  HydratedDocument<AgentStateSegmentSchemaClass>;

/**
 * A CLOSED state segment — the source of truth for agent work-time reporting
 * (docs/agent-presence-workforce-spec.md §3). One document = one continuous
 * span of a single axis value, e.g.:
 *
 *   "Agent X was presence=AVAILABLE from 08:00 to 10:00 (7_200_000 ms)"
 *
 * Reports aggregate these per axis/day. The midnight rollover cron guarantees
 * no segment crosses a day boundary, so `dayKey` fully partitions the data and
 * each day's totals satisfy the reporting invariant (§4.1).
 */
@Schema({ collection: 'agent_state_segments', timestamps: true })
export class AgentStateSegmentSchemaClass {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TenantSchemaClass',
    required: true,
    index: true,
  })
  tenantId: string;

  @Prop({ required: true, index: true })
  agentId: string;

  /** Which timeline this belongs to: presence | routing | work */
  @Prop({ required: true })
  axis: string;

  /** The axis value held for this span (e.g. AVAILABLE, ACCEPTING, IN_CHAT). */
  @Prop({ required: true })
  value: string;

  @Prop({ required: true, type: Date })
  startAt: Date;

  @Prop({ required: true, type: Date })
  endAt: Date;

  @Prop({ required: true })
  durationMs: number;

  /** UTC date (YYYY-MM-DD) of the segment — for fast day-bucketed queries. */
  @Prop({ required: true, index: true })
  dayKey: string;

  /** What caused the transition that closed this segment. */
  @Prop()
  trigger?: string;
}

export const AgentStateSegmentSchema = SchemaFactory.createForClass(
  AgentStateSegmentSchemaClass,
);

// Drill-down: one agent's segments for a day, by axis.
AgentStateSegmentSchema.index({ tenantId: 1, agentId: 1, dayKey: 1, axis: 1 });
// Team-level day reports across all agents.
AgentStateSegmentSchema.index({ tenantId: 1, dayKey: 1, axis: 1 });
// Retention: 400 days (longer than audit log — this is the reporting source).
AgentStateSegmentSchema.index(
  { endAt: 1 },
  { expireAfterSeconds: 400 * 24 * 60 * 60 },
);
