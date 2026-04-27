import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { EntityDocumentHelper } from '../../utils/document-entity-helper';
import { tenantFilterPlugin } from '../../common/plugins/tenant-filter.plugin';

export type AssignmentSettingDocument =
  HydratedDocument<AssignmentSettingSchemaClass>;

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

  @Prop({
    required: true,
    enum: ['Contact', 'Ticket', 'Task', 'Deal'],
  })
  module: string;

  // Core
  @Prop({ default: false })
  autoAssignEnabled: boolean;

  @Prop({
    default: 'round-robin',
    enum: ['round-robin', 'least-busy', 'manual'],
  })
  defaultStrategy: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'GroupSchemaClass' })
  defaultTeamId?: string;

  // Capacity
  @Prop({ default: 50 })
  defaultMaxCapacity: number;

  // Sticky (Omni → CRM integration)
  @Prop({ default: false })
  prioritizeCurrentOwner: boolean;

  // Re-evaluation trigger fields
  @Prop({ type: [String], default: [] })
  triggerFields: string[];

  // Fallback
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'UserSchemaClass' })
  fallbackOwnerId?: string;

  // Working Hours
  @Prop({ default: false })
  respectWorkingHours: boolean;
}

export const AssignmentSettingSchema = SchemaFactory.createForClass(
  AssignmentSettingSchemaClass,
);
AssignmentSettingSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });
AssignmentSettingSchema.index({ tenantId: 1, module: 1 }, { unique: true });
