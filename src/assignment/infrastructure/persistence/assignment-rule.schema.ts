import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { EntityDocumentHelper } from '../../../utils/document-entity-helper';
import { tenantFilterPlugin } from '../../../common/plugins/tenant-filter.plugin';
import {
  ASSIGNMENT_OBJECT_TYPES,
  ASSIGNMENT_STRATEGIES,
  CONDITION_OPERATORS,
  MATCH_TYPES,
} from '../../domain/assignment.types';

export type AssignmentRuleDocument =
  HydratedDocument<AssignmentRuleSchemaClass>;

/**
 * The single rule collection for every objectType.
 *
 * Replaces `assignment_rules` (records only, kebab strategies, 7 operators) and
 * `routing_rules` (conversations only, mixed-case strategies, 4 operators, no
 * operator enum at all). Both are migrated in by
 * `scripts/migrate-assignment-consolidation.ts`.
 */
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
    type: String,
    required: true,
    enum: ASSIGNMENT_OBJECT_TYPES,
  })
  objectType: string;

  @Prop({ required: true, trim: true })
  name: string;

  @Prop({ type: String, default: null })
  description?: string | null;

  @Prop({ required: true, default: 0 })
  priority: number;

  @Prop({
    type: String,
    required: true,
    enum: MATCH_TYPES,
    default: 'all',
  })
  matchType: string;

  @Prop({
    type: [
      {
        _id: false,
        field: { type: String, required: true },
        operator: { type: String, required: true, enum: CONDITION_OPERATORS },
        // Valueless operators (`is_empty`) legitimately store ''.
        value: { type: String, default: '' },
      },
    ],
    default: [],
  })
  conditions: Array<{ field: string; operator: string; value: string }>;

  /**
   * Canonical action shape. There is exactly one way to name teams —
   * `groupIds` as an ordered escalation chain — and one way to pin a person.
   */
  @Prop({
    type: {
      _id: false,
      userId: {
        type: MongooseSchema.Types.ObjectId,
        ref: 'UserSchemaClass',
        default: null,
      },
      groupIds: {
        type: [
          { type: MongooseSchema.Types.ObjectId, ref: 'GroupSchemaClass' },
        ],
        default: [],
      },
      // Null = inherit the objectType's default strategy from settings.
      strategy: { type: String, enum: ASSIGNMENT_STRATEGIES, default: null },
      requiredSkills: { type: [String], default: [] },
    },
    required: true,
    default: () => ({
      userId: null,
      groupIds: [],
      strategy: null,
      requiredSkills: [],
    }),
  })
  actions: {
    userId?: string | null;
    groupIds?: string[];
    strategy?: string | null;
    requiredSkills?: string[];
  };

  @Prop({ default: true })
  enabled: boolean;
}

export const AssignmentRuleSchema = SchemaFactory.createForClass(
  AssignmentRuleSchemaClass,
);

AssignmentRuleSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });

// Hot path: enabled rules for one objectType in priority order.
AssignmentRuleSchema.index({
  tenantId: 1,
  objectType: 1,
  enabled: 1,
  priority: 1,
});
AssignmentRuleSchema.index(
  { tenantId: 1, objectType: 1, name: 1 },
  { unique: true },
);
