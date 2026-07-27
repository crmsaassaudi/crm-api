import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { EntityDocumentHelper } from '../../../utils/document-entity-helper';
import { tenantFilterPlugin } from '../../../common/plugins/tenant-filter.plugin';
import {
  ASSIGNMENT_OBJECT_TYPES,
  ASSIGNMENT_STRATEGIES,
} from '../../domain/assignment.types';

export type AssignmentSettingDocument =
  HydratedDocument<AssignmentSettingSchemaClass>;

/**
 * Per-(tenant, objectType) assignment configuration.
 *
 * Consolidates `assignment_settings` (records) and the `omni_routing` entry of
 * `crm_settings` (conversations), which held the same seven concepts under
 * different names. Narrower scopes — today an omni channel — override
 * individual fields at decision time via `AssignmentConfigService.resolve()`;
 * they are NOT stored here, because a stored override cannot express "inherit
 * this one field" once the schema applies defaults.
 *
 * Fields deliberately absent, having been dead config in the old engine:
 *   - `triggerFields`   — `reassign()` had no caller; re-evaluation is now an
 *                         automation trigger, not a second entry point
 *   - `respectWorkingHours` — was documented "NOT YET ENFORCED"; the
 *                         `business_hours` rule condition covers the real need
 */
@Schema({
  timestamps: true,
  collection: 'assignment_settings',
  toJSON: { virtuals: true, getters: true },
})
export class AssignmentSettingSchemaClass extends EntityDocumentHelper {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TenantSchemaClass',
    required: true,
    index: true,
  })
  tenantId: string;

  @Prop({ type: String, required: true, enum: ASSIGNMENT_OBJECT_TYPES })
  objectType: string;

  /** Master switch. When false nothing is attempted and the outcome is `skipped`. */
  @Prop({ default: false })
  autoAssignEnabled: boolean;

  @Prop({ type: String, enum: ASSIGNMENT_STRATEGIES, default: 'round-robin' })
  defaultStrategy: string;

  /** Pool used when no rule matches. */
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'GroupSchemaClass',
    default: null,
  })
  defaultGroupId?: string | null;

  @Prop({ default: 10, min: 1 })
  defaultMaxCapacity: number;

  /** Person of last resort when no candidate survives filtering. */
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'UserSchemaClass',
    default: null,
  })
  fallbackOwnerId?: string | null;

  /** Strategy used when the preferred-assignee preference falls through. */
  @Prop({ type: String, enum: ASSIGNMENT_STRATEGIES, default: 'round-robin' })
  stickyFallbackStrategy: string;

  @Prop({ default: false })
  skillBasedRoutingEnabled: boolean;

  /**
   * What to do when no candidate holds every required skill. `lenient`
   * (default, historical behaviour) falls back to the full pool; `strict`
   * queues the entity instead of assigning it to an unskilled candidate.
   */
  @Prop({ type: String, enum: ['strict', 'lenient'], default: 'lenient' })
  skillFallbackMode: 'strict' | 'lenient';

  /**
   * Hard-require an online assignee. Replaces
   * `omni_presence.requireOnlineForAssignment[<module>]`, which put a
   * per-objectType assignment gate inside the presence settings document.
   *
   * Only meaningful where the adapter can observe presence; the record adapter
   * treats it as a soft preference (online candidates first).
   */
  @Prop({ default: false })
  requireOnline: boolean;

  // ── Preferred-assignee ("sticky") ────────────────────────────────────────
  //
  // Unifies omni's `stickyRoutingDefault` with the record engine's
  // `prioritizeCurrentOwner`: both meant "give the person who handled this
  // customer/record last first refusal".

  @Prop({ default: false })
  preferPreviousAssignee: boolean;

  @Prop({ default: 72, min: 0 })
  previousAssigneeTimeoutHours: number;

  /**
   * How long to hold the record for a busy preferred assignee before falling
   * through. 0 = do not wait.
   */
  @Prop({ default: 0, min: 0 })
  previousAssigneeWaitMinutes: number;
}

export const AssignmentSettingSchema = SchemaFactory.createForClass(
  AssignmentSettingSchemaClass,
);

AssignmentSettingSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });
AssignmentSettingSchema.index({ tenantId: 1, objectType: 1 }, { unique: true });
