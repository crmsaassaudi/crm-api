import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, now } from 'mongoose';
import { EntityDocumentHelper } from '../../../../../utils/document-entity-helper';
import { tenantFilterPlugin } from '../../../../../common/plugins/tenant-filter.plugin';
import {
  DEFAULT_TASK_PRIORITY,
  TASK_PRIORITIES,
  TASK_RECURRENCE_RULES,
} from '../../../../tasks.constants';

export type TaskSchemaDocument = HydratedDocument<TaskSchemaClass>;

@Schema({
  timestamps: true,
  collection: 'tasks',
  toJSON: {
    virtuals: true,
    getters: true,
  },
})
export class TaskSchemaClass extends EntityDocumentHelper {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TenantSchemaClass',
    required: true,
  })
  tenantId!: string;

  @Prop({ required: true })
  title!: string;

  @Prop()
  description?: string;

  @Prop({ required: true })
  dueDate!: Date;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TaskStatusSchemaClass',
  })
  statusId?: string;

  // `enum` so the database refuses a value the filter could never find. The
  // repository upper-cases values when filtering but writes were unconstrained,
  // so 'high' and 'HIGH' both landed here and each was invisible to a filter for
  // the other.
  @Prop({
    required: true,
    default: DEFAULT_TASK_PRIORITY,
    enum: TASK_PRIORITIES,
  })
  priority!: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'TaskCategorySchemaClass' })
  categoryId?: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'UserSchemaClass' })
  ownerId?: string;

  // Org-unit ownership: the node of the tenant's org tree this record belongs
  // to. Populated at create time from the record owner's org unit; read by the
  // 'org_unit' and 'org_unit_subtree' data scopes.
  @Prop({ type: MongooseSchema.Types.ObjectId, default: null })
  orgUnitId?: string | null;

  @Prop({ type: MongooseSchema.Types.Mixed })
  relatedTo?: {
    type: string;
    _id: string;
    name: string;
  };

  @Prop({ type: [String], default: [] })
  tags?: string[];

  @Prop()
  reminderAt?: Date;

  /**
   * When the reminder was actually delivered.
   *
   * The dispatcher claims a task by setting this field, so a reminder is sent
   * once even though `@Cron` fires in several processes. Also the reason
   * `reminderAt` can be edited after the fact: clearing this alongside it
   * re-arms the reminder.
   */
  @Prop({ type: Date, default: null })
  reminderSentAt?: Date | null;

  @Prop({ type: Date, default: null })
  completedAt?: Date | null;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'TaskSourceSchemaClass' })
  sourceId?: string;

  @Prop({ type: MongooseSchema.Types.Mixed, default: {} })
  customFields?: Record<string, unknown>;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'UserSchemaClass',
    required: true,
  })
  createdById!: string;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'UserSchemaClass',
    required: true,
  })
  updatedById!: string;

  @Prop({ default: now })
  createdAt: Date;

  @Prop({ default: now })
  updatedAt: Date;

  @Prop()
  deletedAt?: Date;

  // RECURRENCE

  /** Whether this is a template task that auto-spawns children */
  @Prop({ default: false })
  isRecurring?: boolean;

  /** Recurrence rule: none / daily / weekly / monthly / yearly */
  @Prop({
    enum: TASK_RECURRENCE_RULES,
    default: 'none',
  })
  recurrenceRule?: 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly';

  /** How many units between occurrences (e.g., 2 = every 2 weeks) */
  @Prop({ default: 1, min: 1, max: 365 })
  recurrenceInterval?: number;

  /** Date after which no more occurrences should be created */
  @Prop({ type: Date, default: null })
  recurrenceEndsAt?: Date | null;

  /** Next scheduled occurrence date (maintained by the cron job) */
  @Prop({ type: Date, default: null })
  nextOccurrenceAt?: Date | null;

  /** If this task was auto-created by a recurrence, its parent template ID */
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TaskSchemaClass',
    default: null,
  })
  parentTaskId?: string | null;
}

export const TaskSchema = SchemaFactory.createForClass(TaskSchemaClass);

TaskSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });

// INDEXES
//
// Every index below is keyed to a query this module actually issues. The set it
// replaces had one index on `status` — a field the schema does not define, it is
// `statusId` — so that index stored null for every document: pure write cost,
// zero reads served. The rest of the set stopped at `{tenantId, dueDate}`, which
// covers neither the soft-delete predicate every read carries nor the second
// sort key, leaving the default list view to sort in memory. That is a hard
// failure rather than a slow one past Mongo's 32MB in-memory sort limit, which a
// tenant reaches somewhere in the hundreds of thousands of tasks.
//
// `autoIndex` is false in production (see MongooseConfigService), so declaring
// them here is necessary but NOT sufficient — `migrate:task-indexes` creates
// them and `verify-operational-indexes` asserts they exist.
//
// Every index is named, and `tasks.indexes.spec.ts` enforces that: an unnamed
// index gets a generated name that neither the migration nor the verifier can
// refer to, so it silently drops out of both. The per-field `index: true` flags
// that used to sit on `tenantId`, `title`, `statusId`, `priority`, `orgUnitId`,
// `reminderAt`, `isRecurring` and `nextOccurrenceAt` are gone for the same
// reason, and because each was already covered by a compound below that leads
// with the same field — eight anonymous indexes of pure write cost.

/** Default list view: tenant + not deleted, sorted by dueDate then _id. */
TaskSchema.index(
  { tenantId: 1, deletedAt: 1, dueDate: 1, _id: 1 },
  { name: 'task_list_default' },
);

/**
 * The same list sorted by recency.
 *
 * Present because `sortBy` offers it. A sort option with no index behind it is
 * how a list view ends up sorting in memory and failing outright past Mongo's
 * 32MB limit — so the DTO only accepts sort fields that appear in an index here.
 */
TaskSchema.index(
  { tenantId: 1, deletedAt: 1, createdAt: -1, _id: -1 },
  { name: 'task_list_created' },
);

/** "My tasks" — the access pattern of every non-manager user. */
TaskSchema.index(
  { tenantId: 1, ownerId: 1, deletedAt: 1, dueDate: 1 },
  { name: 'task_owner_due' },
);

/** Kanban board: one query per status column. */
TaskSchema.index(
  { tenantId: 1, statusId: 1, deletedAt: 1, dueDate: 1 },
  { name: 'task_status_due' },
);

/**
 * Tasks of one contact/deal/ticket.
 *
 * The highest-frequency query the module serves — it runs on every record detail
 * page in the CRM, not just the Tasks page — and it had no index at all, so each
 * one scanned the collection.
 */
TaskSchema.index(
  { tenantId: 1, 'relatedTo._id': 1 },
  { name: 'task_related_lookup' },
);

/** The org-unit data scope. Was a standalone index on orgUnitId, which no
 * tenant-scoped query could use because every such query leads with tenantId. */
TaskSchema.index(
  { tenantId: 1, orgUnitId: 1, deletedAt: 1 },
  { name: 'task_org_unit_scope' },
);

/** Retention purge sweep — cross-tenant, so tenantId is deliberately absent. */
TaskSchema.index({ deletedAt: 1 }, { name: 'task_purge_sweep', sparse: true });

/** Recurrence scheduler sweep — also cross-tenant. */
TaskSchema.index(
  { isRecurring: 1, nextOccurrenceAt: 1, deletedAt: 1 },
  { name: 'recurring_tasks_cron', sparse: true },
);

/** Reminder dispatcher sweep — cross-tenant, unsent reminders only. */
TaskSchema.index(
  { reminderSentAt: 1, reminderAt: 1, deletedAt: 1 },
  { name: 'task_reminder_due' },
);

TaskSchema.virtual('owner', {
  ref: 'UserSchemaClass',
  localField: 'ownerId',
  foreignField: '_id',
  justOne: true,
});

TaskSchema.virtual('taskStatus', {
  ref: 'TaskStatusSchemaClass',
  localField: 'statusId',
  foreignField: '_id',
  justOne: true,
});

TaskSchema.virtual('taskCategory', {
  ref: 'TaskCategorySchemaClass',
  localField: 'categoryId',
  foreignField: '_id',
  justOne: true,
});

TaskSchema.virtual('taskSource', {
  ref: 'TaskSourceSchemaClass',
  localField: 'sourceId',
  foreignField: '_id',
  justOne: true,
});
