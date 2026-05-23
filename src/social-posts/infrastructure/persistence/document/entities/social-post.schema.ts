import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { tenantFilterPlugin } from '../../../../../common/plugins/tenant-filter.plugin';
import { EntityDocumentHelper } from '../../../../../utils/document-entity-helper';
import {
  SOCIAL_POST_APPROVAL_STATUSES,
  SOCIAL_POST_MEDIA_TYPES,
  SOCIAL_POST_STATUSES,
  SocialPostApprovalStatus,
  SocialPostMediaType,
  SocialPostStatus,
} from '../../../../social-posts.types';

export type SocialPostSchemaDocument = HydratedDocument<SocialPostSchemaClass>;

@Schema({
  timestamps: true,
  collection: 'social_posts',
  toJSON: { virtuals: true, getters: true },
})
export class SocialPostSchemaClass extends EntityDocumentHelper {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TenantSchemaClass',
    required: true,
    index: true,
    immutable: true,
  })
  tenantId: string;

  @Prop({ type: String, trim: true, default: '' })
  content: string;

  @Prop({ type: [String], default: [] })
  mediaUrls: string[];

  @Prop({
    type: String,
    enum: SOCIAL_POST_MEDIA_TYPES,
    required: true,
    default: 'text',
  })
  mediaType: SocialPostMediaType;

  @Prop({
    type: String,
    enum: SOCIAL_POST_STATUSES,
    required: true,
    index: true,
    default: 'DRAFT',
  })
  status: SocialPostStatus;

  @Prop({
    type: String,
    enum: SOCIAL_POST_APPROVAL_STATUSES,
    required: true,
    index: true,
    default: 'PENDING',
  })
  approvalStatus: SocialPostApprovalStatus;

  @Prop({ type: Date, index: true })
  scheduledAt?: Date;

  @Prop({ type: Date })
  publishedAt?: Date;

  @Prop({ type: String })
  errorSummary?: string;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'UserSchemaClass',
    immutable: true,
  })
  createdById?: string;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'UserSchemaClass',
  })
  approvedById?: string;

  @Prop({ type: Date })
  approvedAt?: Date;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'SocialPostVersionSchemaClass',
  })
  latestVersionId?: string;
}

export const SocialPostSchema = SchemaFactory.createForClass(
  SocialPostSchemaClass,
);

SocialPostSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });
SocialPostSchema.index(
  { tenantId: 1, status: 1, scheduledAt: 1 },
  { name: 'tenant_post_schedule_lookup' },
);
SocialPostSchema.index(
  { tenantId: 1, approvalStatus: 1, createdAt: -1 },
  { name: 'tenant_post_approval_lookup' },
);
