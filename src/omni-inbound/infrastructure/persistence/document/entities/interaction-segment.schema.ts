import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';

export type InteractionSegmentDocument =
  HydratedDocument<InteractionSegmentSchemaClass>;

/**
 * One handled interaction span (chat/ticket/email/call) for an agent — gap D
 * (docs/agent-presence-workforce-spec.md §2.4, §4). Unlike agent_state_segments
 * (one label via priority-max), these are recorded PER interaction and may
 * OVERLAP in time. Used for per-channel analytics; `T_handle` for Occupancy is
 * the UNION of these (computed at query time), never their sum.
 */
@Schema({ collection: 'interaction_segments', timestamps: true })
export class InteractionSegmentSchemaClass {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TenantSchemaClass',
    required: true,
    index: true,
  })
  tenantId: string;

  @Prop({ required: true, index: true })
  agentId: string;

  /** chat | ticket | email | call */
  @Prop({ required: true })
  type: string;

  /** The interaction's id (conversationId / ticketId / …). */
  @Prop({ required: true })
  refId: string;

  @Prop({ required: true, type: Date })
  startAt: Date;

  @Prop({ required: true, type: Date })
  endAt: Date;

  @Prop({ required: true })
  durationMs: number;

  /** UTC date (YYYY-MM-DD) of startAt — for fast day-bucketed queries. */
  @Prop({ required: true, index: true })
  dayKey: string;
}

export const InteractionSegmentSchema = SchemaFactory.createForClass(
  InteractionSegmentSchemaClass,
);

InteractionSegmentSchema.index({ tenantId: 1, agentId: 1, dayKey: 1, type: 1 });
InteractionSegmentSchema.index({ tenantId: 1, dayKey: 1, type: 1 });
InteractionSegmentSchema.index(
  { endAt: 1 },
  { expireAfterSeconds: 400 * 24 * 60 * 60 },
);
