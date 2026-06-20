import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { EntityDocumentHelper } from '../../../../../utils/document-entity-helper';
import { tenantFilterPlugin } from '../../../../../common/plugins/tenant-filter.plugin';

export type LivechatWidgetSchemaDocument =
  HydratedDocument<LivechatWidgetSchemaClass>;

const WIDGET_STATUSES = ['active', 'paused'] as const;

/**
 * Mongoose schema for livechat widgets.
 *
 * Each widget has a unique `widgetId` (e.g. "wdg_a1b2c3d4e5f6") used
 * in the customer embed snippet. Config is organized into 13 settings
 * groups stored as Mixed sub-documents for maximum flexibility.
 */
@Schema({
  timestamps: true,
  collection: 'livechat_widgets',
  toJSON: { virtuals: true, getters: true },
})
export class LivechatWidgetSchemaClass extends EntityDocumentHelper {
  @Prop({
    type: String,
    required: true,
    unique: true,
    index: true,
  })
  widgetId: string;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TenantSchemaClass',
    required: true,
    index: true,
  })
  tenantId: string;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'ChannelConfigSchemaClass',
    required: true,
    index: true,
  })
  channelId: string;

  @Prop({ type: String, required: true })
  name: string;

  @Prop({ type: String, enum: WIDGET_STATUSES, default: 'active' })
  status: string;

  // ── Settings groups (Mixed JSONB — flexible, schema-less) ───────────────

  @Prop({ type: MongooseSchema.Types.Mixed, default: {} })
  branding: Record<string, any>;

  @Prop({ type: MongooseSchema.Types.Mixed, default: {} })
  theme: Record<string, any>;

  @Prop({ type: MongooseSchema.Types.Mixed, default: {} })
  layout: Record<string, any>;

  @Prop({ type: MongooseSchema.Types.Mixed, default: {} })
  welcome: Record<string, any>;

  @Prop({ type: [MongooseSchema.Types.Mixed], default: [] })
  conversationStarters: Array<Record<string, any>>;

  @Prop({ type: MongooseSchema.Types.Mixed, default: {} })
  offline: Record<string, any>;

  @Prop({ type: MongooseSchema.Types.Mixed, default: {} })
  preChatForm: Record<string, any>;

  @Prop({ type: MongooseSchema.Types.Mixed, default: {} })
  routing: Record<string, any>;

  @Prop({ type: MongooseSchema.Types.Mixed, default: {} })
  automation: Record<string, any>;

  @Prop({ type: MongooseSchema.Types.Mixed, default: {} })
  proactiveChat: Record<string, any>;

  @Prop({ type: MongooseSchema.Types.Mixed, default: {} })
  security: Record<string, any>;

  @Prop({ type: MongooseSchema.Types.Mixed, default: {} })
  localization: Record<string, any>;

  @Prop({ type: MongooseSchema.Types.Mixed, default: {} })
  advanced: Record<string, any>;

  @Prop({ type: MongooseSchema.Types.Mixed, default: {} })
  csat: Record<string, any>;
}

export const LivechatWidgetSchema = SchemaFactory.createForClass(
  LivechatWidgetSchemaClass,
);

LivechatWidgetSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });

// One widget name per channel
LivechatWidgetSchema.index(
  { channelId: 1, name: 1 },
  { unique: true },
);

// Fast lookup by tenant
LivechatWidgetSchema.index({ tenantId: 1, status: 1 });
