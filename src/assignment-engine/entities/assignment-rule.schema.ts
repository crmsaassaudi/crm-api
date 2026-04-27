import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { EntityDocumentHelper } from '../../utils/document-entity-helper';
import { tenantFilterPlugin } from '../../common/plugins/tenant-filter.plugin';

export type AssignmentRuleDocument =
  HydratedDocument<AssignmentRuleSchemaClass>;

@Schema({
  timestamps: true,
  collection: 'assignment_rules',
  toJSON: { virtuals: true, getters: true },
})
export class AssignmentRuleSchemaClass extends EntityDocumentHelper {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TenantSchemaClass',
    required: true,
    index: true,
  })
  tenantId: string;

  @Prop({
    required: true,
    enum: ['Contact', 'Ticket', 'Task', 'Deal'],
  })
  module: string;

  @Prop({ required: true })
  name: string;

  @Prop({ required: true, default: 0 })
  priority: number;

  @Prop({ required: true, enum: ['all', 'any'], default: 'all' })
  matchType: string;

  @Prop({
    type: [
      {
        field: String,
        operator: {
          type: String,
          enum: ['eq', 'neq', 'contains', 'in', 'gt', 'lt', 'between'],
        },
        value: String,
      },
    ],
    default: [],
  })
  conditions: Array<{ field: string; operator: string; value: string }>;

  @Prop({
    type: {
      assignToUserId: {
        type: MongooseSchema.Types.ObjectId,
        ref: 'UserSchemaClass',
      },
      assignToTeamId: {
        type: MongooseSchema.Types.ObjectId,
        ref: 'GroupSchemaClass',
      },
      strategy: {
        type: String,
        enum: ['round-robin', 'least-busy', 'manual'],
        default: 'round-robin',
      },
      requiredSkills: { type: [String], default: [] },
    },
    required: true,
  })
  actions: {
    assignToUserId?: string;
    assignToTeamId?: string;
    strategy: string;
    requiredSkills?: string[];
  };

  @Prop({ default: true })
  enabled: boolean;
}

export const AssignmentRuleSchema = SchemaFactory.createForClass(
  AssignmentRuleSchemaClass,
);
AssignmentRuleSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });
AssignmentRuleSchema.index({ tenantId: 1, module: 1, priority: 1 });
AssignmentRuleSchema.index({ tenantId: 1, module: 1, enabled: 1 });
AssignmentRuleSchema.index(
  { tenantId: 1, module: 1, name: 1 },
  { unique: true },
);
