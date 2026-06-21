import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types, Schema as MongooseSchema } from 'mongoose';

export type WidgetEventDocument = HydratedDocument<WidgetEventSchemaClass>;

@Schema({
  collection: 'livechat_widget_events',
  timestamps: { createdAt: true, updatedAt: false },
})
export class WidgetEventSchemaClass {
  _id: Types.ObjectId;

  @Prop({ required: true, index: true })
  widgetId: string;

  @Prop({ type: Types.ObjectId, required: true, index: true })
  tenantId: Types.ObjectId;

  @Prop({ required: true, index: true })
  event: string;

  @Prop({ type: MongooseSchema.Types.Mixed, default: {} })
  data: Record<string, any>;

  @Prop()
  visitorId?: string;

  @Prop()
  sessionId?: string;

  @Prop()
  pageUrl?: string;

  @Prop()
  domain?: string;

  @Prop({ default: false })
  isMobile?: boolean;

  @Prop({ type: Date, index: true })
  createdAt: Date;
}

export const WidgetEventSchema = SchemaFactory.createForClass(
  WidgetEventSchemaClass,
);

// TTL index — auto-delete events older than 30 days
WidgetEventSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 30 * 24 * 60 * 60 },
);

// Compound indexes for analytics queries
WidgetEventSchema.index({ widgetId: 1, event: 1, createdAt: -1 });
WidgetEventSchema.index({ tenantId: 1, event: 1, createdAt: -1 });
