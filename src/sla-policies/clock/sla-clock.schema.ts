import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { tenantFilterPlugin } from '../../common/plugins/tenant-filter.plugin';
import { EntityDocumentHelper } from '../../utils/document-entity-helper';

/**
 * What a clock is measuring against.
 *
 * Every subject type reaches the same engine — business-hours deadlines,
 * pause/resume, the breach cron, escalation. Keying a clock on one subject's id
 * would put that whole engine behind that subject's events and leave every
 * other kind of work with SLA columns nothing writes.
 */
export const SLA_SUBJECT_TYPES = ['conversation', 'ticket'] as const;
export type SlaSubjectType = (typeof SLA_SUBJECT_TYPES)[number];

export type SlaClockDocument = HydratedDocument<SlaClockSchemaClass>;

@Schema({ timestamps: true, collection: 'sla_clocks' })
export class SlaClockSchemaClass extends EntityDocumentHelper {
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true })
  tenantId: string;

  @Prop({ type: String, enum: SLA_SUBJECT_TYPES, required: true })
  subjectType: SlaSubjectType;

  /** The conversation or ticket this clock belongs to. */
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true })
  subjectId: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, required: true })
  policyId: string;
  @Prop({
    type: String,
    enum: ['first_response', 'next_response', 'resolution'],
    required: true,
  })
  metric: 'first_response' | 'next_response' | 'resolution';
  @Prop({ type: Number, required: true, min: 1 })
  cycle: number;
  @Prop({
    type: String,
    enum: ['running', 'paused', 'met', 'breached', 'cancelled'],
    required: true,
  })
  status: 'running' | 'paused' | 'met' | 'breached' | 'cancelled';
  @Prop({ type: Number, required: true })
  targetMinutes: number;
  @Prop({ type: Date, required: true })
  startedAt: Date;
  @Prop({ type: Date, required: true })
  dueAt: Date;
  @Prop({ type: Date, default: null })
  pausedAt: Date | null;
  @Prop({ type: Number, default: null })
  remainingMinutesAtPause: number | null;
  @Prop({ type: Number, default: 0 })
  totalPausedMs: number;
  @Prop({ type: Date, default: null })
  metAt: Date | null;
  @Prop({ type: Date, default: null })
  breachedAt: Date | null;
  @Prop({ type: String, default: null })
  segment: string | null;
}

export const SlaClockSchema = SchemaFactory.createForClass(SlaClockSchemaClass);
SlaClockSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });
SlaClockSchema.index(
  { tenantId: 1, subjectType: 1, subjectId: 1, metric: 1, cycle: 1 },
  { unique: true, name: 'sla_clock_cycle_unique' },
);
SlaClockSchema.index(
  { status: 1, dueAt: 1, _id: 1 },
  { name: 'sla_clock_breach_scan' },
);
SlaClockSchema.index(
  { tenantId: 1, subjectType: 1, subjectId: 1, status: 1 },
  { name: 'sla_clock_subject_state' },
);
