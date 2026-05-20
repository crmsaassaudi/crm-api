import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, now } from 'mongoose';
import { EntityDocumentHelper } from '../../../../../utils/document-entity-helper';
import { tenantFilterPlugin } from '../../../../../common/plugins/tenant-filter.plugin';

export type ActivityLogSchemaDocument =
  HydratedDocument<ActivityLogSchemaClass>;

@Schema({
  timestamps: true,
  collection: 'activity_logs',
  toJSON: {
    virtuals: true,
    getters: true,
  },
})
export class ActivityLogSchemaClass extends EntityDocumentHelper {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TenantSchemaClass',
    required: true,
    index: true,
  })
  tenantId: string;

  @Prop({ required: true, index: true })
  targetType: string;

  @Prop({ required: true, index: true })
  targetId: string;

  @Prop({ required: true, index: true })
  event: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'UserSchemaClass' })
  actorId?: string;

  @Prop({ type: MongooseSchema.Types.Mixed })
  payload?: Record<string, any>;

  @Prop({ default: now, index: true })
  occurredAt: Date;

  @Prop({ default: now })
  createdAt: Date;

  @Prop({ default: now })
  updatedAt: Date;
}

export const ActivityLogSchema = SchemaFactory.createForClass(
  ActivityLogSchemaClass,
);

ActivityLogSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });
ActivityLogSchema.index(
  { targetType: 1, targetId: 1, tenantId: 1, occurredAt: -1 },
  { name: 'target_activity_lookup' },
);
