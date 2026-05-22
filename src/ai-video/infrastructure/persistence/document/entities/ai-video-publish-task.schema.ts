import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { EntityDocumentHelper } from '../../../../../utils/document-entity-helper';

export type AiVideoPublishTaskSchemaDocument =
  HydratedDocument<AiVideoPublishTaskSchemaClass>;

/**
 * Isolated publish task record for tracking Meta Graph API upload attempts.
 * Separating this from AiVideoJob prevents retry metadata from polluting the
 * main job record and enables independent retry/dead-letter management.
 */
@Schema({
  timestamps: true,
  collection: 'ai_video_publish_tasks',
})
export class AiVideoPublishTaskSchemaClass extends EntityDocumentHelper {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TenantSchemaClass',
    required: true,
    index: true,
    immutable: true,
  })
  tenantId: MongooseSchema.Types.ObjectId;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'AiVideoJobSchemaClass',
    required: true,
    index: true,
    immutable: true,
  })
  jobId: MongooseSchema.Types.ObjectId;

  @Prop({ type: String, required: true, default: 'facebook', immutable: true })
  platform: 'facebook';

  @Prop({ type: String, required: true, immutable: true })
  facebookPageId: string;

  @Prop({ type: Date, required: true })
  scheduledAt: Date;

  @Prop({
    type: String,
    required: true,
    index: true,
    default: 'PENDING',
    enum: ['PENDING', 'PUBLISHING', 'SUCCESS', 'FAILED'],
  })
  status: 'PENDING' | 'PUBLISHING' | 'SUCCESS' | 'FAILED';

  @Prop({ type: String })
  platformVideoId?: string;

  @Prop({ type: String })
  platformPostId?: string;

  @Prop({ type: MongooseSchema.Types.Mixed })
  platformResponseRaw?: any;

  @Prop({ type: Number, default: 0 })
  retryCount: number;

  @Prop({ type: Number, default: 3 })
  maxRetries: number;

  @Prop({ type: String })
  lastErrorCode?: string;

  @Prop({ type: String })
  lastErrorMessage?: string;
}

export const AiVideoPublishTaskSchema = SchemaFactory.createForClass(
  AiVideoPublishTaskSchemaClass,
);

AiVideoPublishTaskSchema.index(
  { tenantId: 1, status: 1, scheduledAt: 1 },
  { name: 'tenant_publish_task_schedule_lookup' },
);
