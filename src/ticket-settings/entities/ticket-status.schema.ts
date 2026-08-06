import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { EntityDocumentHelper } from '../../utils/document-entity-helper';
import { tenantFilterPlugin } from '../../common/plugins/tenant-filter.plugin';

export type TicketStatusDocument = HydratedDocument<TicketStatusSchemaClass>;

@Schema({
  timestamps: true,
  collection: 'ticket_statuses',
  toJSON: { virtuals: true, getters: true },
})
export class TicketStatusSchemaClass extends EntityDocumentHelper {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TenantSchemaClass',
    required: true,
    index: true,
  })
  tenantId: string;

  @Prop({ required: true })
  label: string;

  @Prop({ required: true })
  apiName: string;

  @Prop({ default: '#3b82f6' })
  color: string;

  @Prop({ default: 0 })
  sortOrder: number;

  @Prop({ default: false })
  isDefault: boolean;

  @Prop({ default: false })
  isTerminal: boolean;

  /**
   * Which terminal state this status represents.
   *
   * `isTerminal` alone could not tell Resolved from Closed, so entering either
   * one stamped BOTH `resolvedAt` and `closedAt`. Time-to-resolve therefore
   * equalled time-to-close by construction, "resolved, awaiting the customer's
   * confirmation" was unrepresentable, and a resolved ticket dropped out of the
   * agent's workload the moment it was resolved.
   *
   * `null` on a non-terminal status. Kept alongside `isTerminal` rather than
   * replacing it because the transition guard only asks "is this an end state".
   */
  @Prop({ type: String, enum: ['resolved', 'closed', null], default: null })
  terminalKind: 'resolved' | 'closed' | null;

  /**
   * Whether sitting in this status stops the SLA clock.
   *
   * "Waiting on customer" is the case that matters: an agent is not late
   * because the customer took the weekend to reply.
   */
  @Prop({ default: false })
  pausesSla: boolean;
}

export const TicketStatusSchema = SchemaFactory.createForClass(
  TicketStatusSchemaClass,
);
TicketStatusSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });
TicketStatusSchema.index({ tenantId: 1, apiName: 1 }, { unique: true });
TicketStatusSchema.index({ tenantId: 1, sortOrder: 1 });
