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
  { tenantId: 1, targetType: 1, targetId: 1, occurredAt: -1 },
  { name: 'target_activity_lookup' },
);

// Retention: 180 days.
//
// This collection is written from every domain and read almost exclusively as
// "what happened to this record recently" on a detail page. It had no TTL and
// no purge, so it grew without bound while seventeen smaller, less-written
// collections had one — the inversion the data audit called out.
//
// 180 days is long enough to cover a quarterly review and an escalation that
// goes several weeks; it is deliberately shorter than `audit_logs`, which
// answers a different (compliance) question and needs its own policy decision.
ActivityLogSchema.index(
  { occurredAt: 1 },
  { name: 'activity_log_ttl', expireAfterSeconds: 180 * 86_400 },
);

ActivityLogSchema.virtual('actor', {
  ref: 'UserSchemaClass',
  localField: 'actorId',
  foreignField: '_id',
  justOne: true,
});
