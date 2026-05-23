import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { tenantFilterPlugin } from '../../../../../common/plugins/tenant-filter.plugin';
import { EntityDocumentHelper } from '../../../../../utils/document-entity-helper';
import {
  SOCIAL_POST_PLATFORMS,
  SOCIAL_POST_TASK_STATUSES,
  SocialPostPlatform,
  SocialPostTaskStatus,
} from '../../../../social-posts.types';

export type SocialPostTaskSchemaDocument =
  HydratedDocument<SocialPostTaskSchemaClass>;

@Schema({
  timestamps: true,
  collection: 'social_post_tasks',
  toJSON: { virtuals: true, getters: true },
})
export class SocialPostTaskSchemaClass extends EntityDocumentHelper {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TenantSchemaClass',
    required: true,
    index: true,
    immutable: true,
  })
  tenantId: string;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'SocialPostSchemaClass',
    required: true,
    index: true,
    immutable: true,
  })
  postId: string;

  @Prop({ type: String, required: true, index: true })
  batchId: string;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'ChannelSchemaClass',
    required: true,
    index: true,
  })
  channelId: string;

  @Prop({ type: String, required: true })
  channelName: string;

  @Prop({ type: String, required: true })
  channelAccount: string;

  @Prop({ type: String, required: true, default: '' })
  postContent: string;

  @Prop({ type: [String], default: [] })
  postMediaUrls: string[];

  @Prop({ type: String, required: true, default: 'text' })
  postMediaType: string;

  @Prop({
    type: String,
    enum: SOCIAL_POST_PLATFORMS,
    required: true,
    index: true,
  })
  platform: SocialPostPlatform;

  @Prop({
    type: String,
    enum: SOCIAL_POST_TASK_STATUSES,
    required: true,
    index: true,
    default: 'PENDING',
  })
  status: SocialPostTaskStatus;

  @Prop({ type: Date })
  scheduledAt?: Date;

  @Prop({ type: Date })
  publishedAt?: Date;

  @Prop({ type: String })
  platformPostId?: string;

  @Prop({ type: String })
  platformMediaId?: string;

  @Prop({ type: MongooseSchema.Types.Mixed })
  platformResponseRaw?: Record<string, any>;

  @Prop({ type: Number, default: 0 })
  retryCount: number;

  @Prop({ type: Number, default: 3 })
  maxRetries: number;

  @Prop({ type: String })
  errorCode?: string;

  @Prop({ type: String })
  errorMessage?: string;
}

export const SocialPostTaskSchema = SchemaFactory.createForClass(
  SocialPostTaskSchemaClass,
);

SocialPostTaskSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });
SocialPostTaskSchema.index(
  { tenantId: 1, batchId: 1, channelId: 1 },
  { name: 'tenant_publish_batch_channel_task_lookup', unique: true },
);
SocialPostTaskSchema.index(
  { tenantId: 1, status: 1, scheduledAt: 1 },
  { name: 'tenant_task_schedule_lookup' },
);
