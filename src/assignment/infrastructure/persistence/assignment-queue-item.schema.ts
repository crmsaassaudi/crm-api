import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { EntityDocumentHelper } from '../../../utils/document-entity-helper';
import { tenantFilterPlugin } from '../../../common/plugins/tenant-filter.plugin';
import { ASSIGNMENT_OBJECT_TYPES } from '../../domain/assignment.types';

export type AssignmentQueueItemDocument =
  HydratedDocument<AssignmentQueueItemSchemaClass>;

@Schema({
  timestamps: true,
  collection: 'assignment_queue_items',
  toJSON: { virtuals: true, getters: true },
})
export class AssignmentQueueItemSchemaClass extends EntityDocumentHelper {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TenantSchemaClass',
    required: true,
  })
  tenantId: string;

  @Prop({ type: String, enum: ASSIGNMENT_OBJECT_TYPES, required: true })
  objectType: string;

  @Prop({ type: String, required: true })
  entityId: string;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'GroupSchemaClass',
    required: true,
  })
  groupId: string;

  @Prop({
    type: String,
    enum: ['queued', 'claiming', 'retrying'],
    default: 'queued',
  })
  status: 'queued' | 'claiming' | 'retrying';

  @Prop({ type: Date, required: true, default: () => new Date() })
  queuedAt: Date;

  @Prop({ type: String, default: null })
  reasonKey?: string | null;

  @Prop({ type: String, default: null })
  operationId?: string | null;

  @Prop({ type: Date, default: null })
  operationStartedAt?: Date | null;

  @Prop({ type: Number, default: 0 })
  attemptCount: number;

  @Prop({ type: Date, default: null })
  lastAttemptAt?: Date | null;

  @Prop({ type: Date, default: null })
  escalatedAt?: Date | null;

  @Prop({ type: Number, default: 0 })
  escalationCount: number;

  @Prop({ type: Number, default: 50, min: 0, max: 100 })
  priority: number;

  @Prop({ type: Date, default: null })
  slaDueAt?: Date | null;
}

export const AssignmentQueueItemSchema = SchemaFactory.createForClass(
  AssignmentQueueItemSchemaClass,
);
AssignmentQueueItemSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });
AssignmentQueueItemSchema.index(
  { tenantId: 1, objectType: 1, entityId: 1 },
  { unique: true, name: 'assignment_queue_entity_unique' },
);
AssignmentQueueItemSchema.index(
  {
    tenantId: 1,
    objectType: 1,
    groupId: 1,
    priority: -1,
    slaDueAt: 1,
    queuedAt: 1,
    _id: 1,
  },
  { name: 'assignment_queue_list' },
);
AssignmentQueueItemSchema.index(
  { status: 1, escalatedAt: 1, queuedAt: 1 },
  { name: 'assignment_queue_escalation_due' },
);
