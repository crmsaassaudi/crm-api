import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';
import { EntityDocumentHelper } from '../../../../../utils/document-entity-helper';
import { tenantFilterPlugin } from '../../../../../common/plugins/tenant-filter.plugin';

export type EscalationPolicySchemaDocument =
  HydratedDocument<EscalationPolicySchemaClass>;

@Schema({ timestamps: true, collection: 'escalation_policies' })
export class EscalationPolicySchemaClass extends EntityDocumentHelper {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TenantSchemaClass',
    required: true,
    index: true,
  })
  tenantId: string;

  @Prop({ required: true })
  name: string;

  @Prop({ type: Types.ObjectId, required: true })
  slaId: Types.ObjectId;

  @Prop({
    required: true,
    enum: ['warning', 'breach'],
  })
  breachType: string;

  /**
   * Time after SLA breach before this escalation triggers.
   * Example: escalateAfter=5, escalateUnit='minutes' → 5 minutes after breach
   */
  @Prop({ required: true, min: 0 })
  escalateAfter: number;

  @Prop({
    required: true,
    enum: ['minutes', 'hours'],
    default: 'minutes',
  })
  escalateUnit: string;

  @Prop({
    type: [{ type: { type: String }, value: String }],
    default: [],
  })
  actions: Array<{ type: string; value: string }>;

  @Prop({ default: true })
  enabled: boolean;
}

export const EscalationPolicySchema = SchemaFactory.createForClass(
  EscalationPolicySchemaClass,
);

EscalationPolicySchema.plugin(tenantFilterPlugin, { field: 'tenantId' });

EscalationPolicySchema.index({ tenantId: 1, name: 1 }, { unique: true });
