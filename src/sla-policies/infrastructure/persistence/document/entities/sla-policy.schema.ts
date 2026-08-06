import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { EntityDocumentHelper } from '../../../../../utils/document-entity-helper';
import { tenantFilterPlugin } from '../../../../../common/plugins/tenant-filter.plugin';

export type SlaPolicySchemaDocument = HydratedDocument<SlaPolicySchemaClass>;

@Schema({
  timestamps: true,
  collection: 'sla_policies',
  toJSON: { virtuals: true, getters: true },
})
export class SlaPolicySchemaClass extends EntityDocumentHelper {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TenantSchemaClass',
    required: true,
    index: true,
  })
  tenantId: string;

  @Prop({ required: true })
  name: string;

  /**
   * Which kind of work this policy governs.
   *
   * A support ticket and a live chat owe the customer very different response
   * times, so one undifferentiated policy list cannot serve both. Required, and
   * without a schema default on purpose: a policy that silently defaults to
   * `conversation` would apply to chats a tenant meant to leave unmeasured.
   */
  @Prop({ type: String, required: true, enum: ['conversation', 'ticket'] })
  appliesTo: 'conversation' | 'ticket';

  @Prop({
    type: String,
    required: true,
    enum: ['first_response', 'resolution', 'next_response'],
  })
  type: string;

  /**
   * Per-segment targets, most specific first.
   *
   * `segment` is the axis that selects a target within the policy: on a ticket
   * policy it is the priority (`URGENT` / `HIGH` / `MEDIUM` / `LOW`), which is
   * how "High priority → first response within 15 minutes" is expressed. A
   * target with `segment: null` is the policy's catch-all.
   */
  @Prop({
    type: [
      {
        segment: { type: String, default: null },
        timeValue: Number,
        timeUnit: { type: String, enum: ['minutes', 'hours', 'days'] },
      },
    ],
    default: [],
  })
  targets: Array<{
    segment: string | null;
    timeValue: number;
    timeUnit: string;
  }>;

  @Prop({ default: true })
  enabled: boolean;

  @Prop({ default: 0 })
  priority: number;
}

export const SlaPolicySchema =
  SchemaFactory.createForClass(SlaPolicySchemaClass);

SlaPolicySchema.plugin(tenantFilterPlugin, { field: 'tenantId' });
SlaPolicySchema.index({ tenantId: 1, name: 1 }, { unique: true });
// Backs `findApplicable`, which runs on every lifecycle event of every
// conversation and every ticket.
SlaPolicySchema.index(
  { tenantId: 1, appliesTo: 1, type: 1, enabled: 1, priority: -1 },
  { name: 'sla_policy_selection' },
);
