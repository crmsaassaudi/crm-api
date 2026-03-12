import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { EntityDocumentHelper } from '../../../../../utils/document-entity-helper';
import { tenantFilterPlugin } from '../../../../../common/plugins/tenant-filter.plugin';

export type EscalationPolicySchemaDocument =
  HydratedDocument<EscalationPolicySchemaClass>;

@Schema({ timestamps: true, collection: 'escalationPolicies' })
export class EscalationPolicySchemaClass extends EntityDocumentHelper {
  @Prop({ required: true, index: true })
  tenant: string;

  @Prop({ required: true })
  name: string;

  @Prop({ type: Types.ObjectId, required: true })
  slaId: Types.ObjectId;

  @Prop({ required: true, enum: ['warning', 'breach'] })
  breachType: string;

  @Prop({ required: true, min: 0, max: 100 })
  thresholdPercentage: number;

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

EscalationPolicySchema.plugin(tenantFilterPlugin);

EscalationPolicySchema.index({ tenant: 1, name: 1 }, { unique: true });
