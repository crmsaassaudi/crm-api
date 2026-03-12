import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { EntityDocumentHelper } from '../../../../../utils/document-entity-helper';
import { tenantFilterPlugin } from '../../../../../common/plugins/tenant-filter.plugin';

export type RoutingRuleSchemaDocument =
  HydratedDocument<RoutingRuleSchemaClass>;

@Schema({ timestamps: true, collection: 'routingRules' })
export class RoutingRuleSchemaClass extends EntityDocumentHelper {
  @Prop({ required: true, index: true })
  tenant: string;

  @Prop({ required: true })
  name: string;

  @Prop({ required: true, default: 0 })
  priority: number;

  @Prop({ required: true, enum: ['all', 'any'], default: 'all' })
  matchType: string;

  @Prop({
    type: [{ field: String, operator: String, value: String }],
    default: [],
  })
  conditions: Array<{ field: string; operator: string; value: string }>;

  @Prop({
    type: {
      teamId: String,
      strategy: {
        type: String,
        enum: ['round_robin', 'least_busy', 'manual'],
      },
      sticky: Boolean,
    },
    required: true,
  })
  actions: { teamId: string; strategy: string; sticky: boolean };

  @Prop({ default: true })
  enabled: boolean;
}

export const RoutingRuleSchema = SchemaFactory.createForClass(
  RoutingRuleSchemaClass,
);

RoutingRuleSchema.plugin(tenantFilterPlugin);

RoutingRuleSchema.index({ tenant: 1, name: 1 }, { unique: true });
RoutingRuleSchema.index({ tenant: 1, priority: 1 });
