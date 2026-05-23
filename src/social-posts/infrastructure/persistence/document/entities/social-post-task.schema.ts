import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { tenantFilterPlugin } from '../../../../../common/plugins/tenant-filter.plugin';
import { EntityDocumentHelper } from '../../../../../utils/document-entity-helper';
import {
  PUBLICATION_INSTANCE_STATUSES,
  SOCIAL_CONTENT_MEDIA_TYPES,
  SOCIAL_CONTENT_PLATFORMS,
  PublicationInstanceStatus,
  SocialContentMediaType,
  SocialContentPlatform,
} from '../../../../social-posts.types';

export type PublicationInstanceSchemaDocument =
  HydratedDocument<PublicationInstanceSchemaClass>;

@Schema({
  timestamps: true,
  collection: 'publication_instances',
  toJSON: { virtuals: true, getters: true },
})
export class PublicationInstanceSchemaClass extends EntityDocumentHelper {
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
    ref: 'SocialContentAssetSchemaClass',
    required: true,
    index: true,
    immutable: true,
  })
  assetId: string;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'SocialContentAssetVersionSchemaClass',
    required: true,
    index: true,
    immutable: true,
  })
  sourceVersionId: string;

  @Prop({ type: String, required: true, index: true, immutable: true })
  publicationGroupId: string;

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

  @Prop({
    type: String,
    enum: SOCIAL_CONTENT_PLATFORMS,
    required: true,
    index: true,
  })
  platform: SocialContentPlatform;

  @Prop({
    type: {
      content: { type: String, default: '' },
      mediaUrls: { type: [String], default: [] },
      mediaType: {
        type: String,
        enum: SOCIAL_CONTENT_MEDIA_TYPES,
        required: true,
        default: 'text',
      },
    },
    _id: false,
    required: true,
  })
  snapshot: {
    content: string;
    mediaUrls: string[];
    mediaType: SocialContentMediaType;
  };

  @Prop({
    type: String,
    enum: PUBLICATION_INSTANCE_STATUSES,
    required: true,
    index: true,
    default: 'PENDING',
  })
  status: PublicationInstanceStatus;

  @Prop({ type: Date, index: true })
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

export const PublicationInstanceSchema = SchemaFactory.createForClass(
  PublicationInstanceSchemaClass,
);

PublicationInstanceSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });
PublicationInstanceSchema.index(
  { tenantId: 1, publicationGroupId: 1, channelId: 1 },
  { name: 'tenant_publication_group_channel_lookup', unique: true },
);
PublicationInstanceSchema.index(
  { tenantId: 1, status: 1, scheduledAt: 1 },
  { name: 'tenant_publication_schedule_lookup' },
);
PublicationInstanceSchema.index(
  { tenantId: 1, assetId: 1, updatedAt: -1 },
  { name: 'tenant_publication_asset_lookup' },
);
