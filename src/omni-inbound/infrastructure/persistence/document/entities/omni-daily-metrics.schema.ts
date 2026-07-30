import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { EntityDocumentHelper } from '../../../../../utils/document-entity-helper';
import { tenantFilterPlugin } from '../../../../../common/plugins/tenant-filter.plugin';

export type OmniDailyMetricsDocument =
  HydratedDocument<OmniDailyMetricsSchemaClass>;

@Schema({
  timestamps: true,
  collection: 'omni_daily_metrics',
  toJSON: { virtuals: true, getters: true },
})
export class OmniDailyMetricsSchemaClass extends EntityDocumentHelper {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TenantSchemaClass',
    required: true,
  })
  tenantId: string;

  @Prop({ type: Date, required: true })
  day: Date;

  @Prop({ type: String, required: true, default: 'unknown' })
  channelType: string;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'InboxSchemaClass',
    default: null,
  })
  inboxId: string | null;

  @Prop({ type: Number, default: 0 })
  createdCount: number;

  @Prop({ type: Number, default: 0 })
  reopenedCount: number;

  @Prop({ type: Number, default: 0 })
  resolvedCount: number;

  @Prop({ type: Number, default: 0 })
  closedCount: number;

  @Prop({ type: Number, default: 0 })
  assignedCount: number;

  @Prop({ type: Number, default: 0 })
  inboundMessageCount: number;

  @Prop({ type: Number, default: 0 })
  outboundMessageCount: number;

  @Prop({ type: Number, default: 0 })
  slaBreachedCount: number;
}

export const OmniDailyMetricsSchema = SchemaFactory.createForClass(
  OmniDailyMetricsSchemaClass,
);
OmniDailyMetricsSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });
OmniDailyMetricsSchema.index(
  { tenantId: 1, day: 1, channelType: 1, inboxId: 1 },
  { unique: true, name: 'omni_daily_metrics_unique_bucket' },
);
OmniDailyMetricsSchema.index(
  { tenantId: 1, day: 1 },
  { name: 'omni_daily_metrics_tenant_day' },
);
