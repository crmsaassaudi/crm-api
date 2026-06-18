import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { EntityDocumentHelper } from '../utils/document-entity-helper';
import { tenantFilterPlugin } from '../common/plugins/tenant-filter.plugin';

export type LeadScoringRuleDocument =
  HydratedDocument<LeadScoringRuleSchemaClass>;

/**
 * Supported operators for rule conditions.
 * Mirrors what the frontend rule builder exposes.
 */
export const SCORING_OPERATORS = [
  'equals',
  'not_equals',
  'contains',
  'not_contains',
  'exists',
  'not_exists',
  'greater_than',
  'less_than',
] as const;

export type ScoringOperator = (typeof SCORING_OPERATORS)[number];

/**
 * Supported contact field paths that can be scored.
 * Extend this list as the contact model grows.
 */
export const SCORABLE_FIELDS = [
  'emails', // has email
  'phones', // has phone
  'companyName', // has company
  'title', // has job title
  'sourceId', // lead source
  'lifecycleStageId', // lifecycle stage
  'statusId', // contact status
  'tags', // tag membership
  'emailOptIn', // email opt-in
  'customFields', // any custom field key
  'activity.type', // triggered by activity type
  'deal.stage', // deal created with specific stage
] as const;

export type ScorableField = (typeof SCORABLE_FIELDS)[number];

export interface ScoringCondition {
  /** Contact field path */
  field: string;
  /** Comparison operator */
  operator: ScoringOperator;
  /** Value to compare against (omit for exists/not_exists) */
  value?: string | number | boolean;
  /** For customFields, the key within customFields object */
  customFieldKey?: string;
}

@Schema({
  timestamps: true,
  collection: 'lead_scoring_rules',
  toJSON: { virtuals: true, getters: true },
})
export class LeadScoringRuleSchemaClass extends EntityDocumentHelper {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TenantSchemaClass',
    required: true,
    index: true,
  })
  tenantId: string;

  /** Human-readable rule name */
  @Prop({ required: true })
  name: string;

  /** Optional description */
  @Prop()
  description?: string;

  /**
   * Points awarded (+) or deducted (-) when condition matches.
   * Negative values are allowed for degrading stale/negative signals.
   */
  @Prop({ required: true })
  points: number;

  /** Condition that must match to apply this rule */
  @Prop({ type: MongooseSchema.Types.Mixed, required: true })
  condition: ScoringCondition;

  /**
   * When to evaluate this rule:
   * - 'on_create' : applied when contact is first created
   * - 'on_update' : re-evaluated on every contact update
   * - 'on_activity': triggered when an activity event fires
   * - 'always'    : applied in all contexts
   */
  @Prop({
    type: String,
    enum: ['on_create', 'on_update', 'on_activity', 'always'],
    default: 'always',
  })
  trigger: 'on_create' | 'on_update' | 'on_activity' | 'always';

  /** Soft-delete / disable rule without removing it */
  @Prop({ default: true })
  isActive: boolean;

  /** Display order in rule builder UI */
  @Prop({ default: 0 })
  sortOrder: number;
}

export const LeadScoringRuleSchema = SchemaFactory.createForClass(
  LeadScoringRuleSchemaClass,
);
LeadScoringRuleSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });
LeadScoringRuleSchema.index({ tenantId: 1, isActive: 1 });
