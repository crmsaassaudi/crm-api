import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { EntityDocumentHelper } from '../../../utils/document-entity-helper';
import { tenantFilterPlugin } from '../../../common/plugins/tenant-filter.plugin';
import { ASSIGNMENT_OBJECT_TYPES } from '../../domain/assignment.types';

export type AssignmentCommandDocument =
  HydratedDocument<AssignmentCommandSchemaClass>;

@Schema({
  timestamps: true,
  collection: 'assignment_commands',
  toJSON: { virtuals: true, getters: true },
})
export class AssignmentCommandSchemaClass extends EntityDocumentHelper {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TenantSchemaClass',
    required: true,
  })
  tenantId: string;

  @Prop({ type: String, required: true })
  idempotencyKey: string;

  @Prop({ type: String, enum: ASSIGNMENT_OBJECT_TYPES, required: true })
  objectType: string;

  @Prop({ type: String, required: true })
  entityId: string;

  @Prop({
    type: String,
    enum: ['processing', 'completed', 'failed'],
    required: true,
  })
  status: 'processing' | 'completed' | 'failed';

  @Prop({ type: MongooseSchema.Types.Mixed, required: true })
  request: Record<string, any>;

  @Prop({ type: MongooseSchema.Types.Mixed, default: null })
  decision?: Record<string, any> | null;

  @Prop({ type: String, default: null })
  error?: string | null;

  @Prop({ type: Date, default: null })
  completedAt?: Date | null;
}

export const AssignmentCommandSchema = SchemaFactory.createForClass(
  AssignmentCommandSchemaClass,
);
AssignmentCommandSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });
AssignmentCommandSchema.index(
  { tenantId: 1, idempotencyKey: 1 },
  { unique: true, name: 'assignment_command_idempotency' },
);
AssignmentCommandSchema.index(
  { status: 1, updatedAt: 1 },
  { name: 'assignment_command_recovery' },
);
