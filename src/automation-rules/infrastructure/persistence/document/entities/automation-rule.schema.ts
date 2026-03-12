import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { EntityDocumentHelper } from '../../../../../utils/document-entity-helper';
import { tenantFilterPlugin } from '../../../../../common/plugins/tenant-filter.plugin';

export type AutomationRuleSchemaDocument =
  HydratedDocument<AutomationRuleSchemaClass>;

@Schema({ timestamps: true, collection: 'automationRules' })
export class AutomationRuleSchemaClass extends EntityDocumentHelper {
  @Prop({ required: true, index: true })
  tenant: string;

  @Prop({ required: true })
  name: string;

  @Prop({
    type: {
      event: { type: String, required: true },
      matchType: { type: String, enum: ['all', 'any'], default: 'all' },
      conditions: [{ field: String, operator: String, value: String }],
    },
    required: true,
  })
  trigger: {
    event: string;
    matchType: string;
    conditions: Array<{ field: string; operator: string; value: string }>;
  };

  @Prop({
    type: [{ type: { type: String }, value: String }],
    default: [],
  })
  actions: Array<{ type: string; value: string }>;

  @Prop({ default: true })
  enabled: boolean;

  @Prop({ default: 0 })
  executionCount: number;

  @Prop({ type: Date, default: null })
  lastExecutedAt: Date | null;
}

export const AutomationRuleSchema = SchemaFactory.createForClass(
  AutomationRuleSchemaClass,
);

AutomationRuleSchema.plugin(tenantFilterPlugin);

AutomationRuleSchema.index({ tenant: 1, name: 1 }, { unique: true });
