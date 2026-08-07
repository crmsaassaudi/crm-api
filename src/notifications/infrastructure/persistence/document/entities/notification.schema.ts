import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { EntityDocumentHelper } from '../../../../../utils/document-entity-helper';
import { tenantFilterPlugin } from '../../../../../common/plugins/tenant-filter.plugin';

export type NotificationDocument = HydratedDocument<NotificationSchemaClass>;

/**
 * The notification types produced today. Each maps 1:1 to one of
 * `CrmRealtimeGateway`'s personal (per-user) Redis channels — the ones that
 * name a single recipient, as opposed to a tenant-wide job-status broadcast
 * (export/import completion), which this inbox does not carry.
 */
export const NOTIFICATION_TYPES = [
  'task_reminder',
  'deal_follow_up',
  'automation',
  'escalation',
  'auto_resolve_warning',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

@Schema({
  timestamps: true,
  collection: 'notifications',
  toJSON: { virtuals: true, getters: true },
})
export class NotificationSchemaClass extends EntityDocumentHelper {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TenantSchemaClass',
    required: true,
    index: true,
  })
  tenantId: string;

  /** Who this notification is for — never the actor who caused it. */
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'UserSchemaClass',
    required: true,
    index: true,
  })
  userId: string;

  @Prop({ type: String, required: true, enum: NOTIFICATION_TYPES })
  type: NotificationType;

  @Prop({ required: true })
  title: string;

  @Prop()
  body?: string;

  /** Where clicking the notification should take the user, if anywhere. */
  @Prop({ type: MongooseSchema.Types.Mixed, default: null })
  link: { type: string; id: string } | null;

  @Prop({ type: Date, default: null })
  readAt: Date | null;
}

export const NotificationSchema = SchemaFactory.createForClass(
  NotificationSchemaClass,
);

NotificationSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });

// The inbox's two real queries: "my notifications, newest first" and
// "how many of mine are unread" — both scoped to `userId` first since every
// caller is asking about themselves, never another user's inbox.
NotificationSchema.index({ tenantId: 1, userId: 1, createdAt: -1 });
NotificationSchema.index({ tenantId: 1, userId: 1, readAt: 1 });

// Bounds inbox growth without a separate cron: a notification a user never
// opened for 90 days is not something they are coming back for.
NotificationSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 60 * 60 * 24 * 90 },
);
