import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { tenantFilterPlugin } from '../../../../../common/plugins/tenant-filter.plugin';
import { EntityDocumentHelper } from '../../../../../utils/document-entity-helper';
import {
  SOCIAL_CONTENT_APPROVAL_STATUSES,
  SOCIAL_CONTENT_MEDIA_TYPES,
  SocialContentApprovalStatus,
  SocialContentMediaType,
} from '../../../../social-posts.types';

export type SocialContentAssetVersionSchemaDocument =
  HydratedDocument<SocialContentAssetVersionSchemaClass>;

@Schema({
  timestamps: true,
  collection: 'social_content_asset_versions',
  toJSON: { virtuals: true, getters: true },
})
export class SocialContentAssetVersionSchemaClass extends EntityDocumentHelper {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TenantSchemaClass',
    required: true,
    immutable: true,
    index: true,
  })
  tenantId: string;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'SocialContentAssetSchemaClass',
    required: true,
    immutable: true,
    index: true,
  })
  assetId: string;

  @Prop({ type: Number, required: true })
  versionNumber: number;

  @Prop({ type: String, trim: true, default: '' })
  content: string;

  @Prop({ type: [String], default: [] })
  mediaUrls: string[];

  @Prop({ type: [String], default: [] })
  aiVideoJobIds: string[];

  @Prop({
    type: String,
    enum: SOCIAL_CONTENT_MEDIA_TYPES,
    required: true,
    default: 'text',
  })
  mediaType: SocialContentMediaType;

  @Prop({
    type: String,
    enum: SOCIAL_CONTENT_APPROVAL_STATUSES,
    required: true,
    index: true,
    default: 'PENDING',
  })
  approvalStatus: SocialContentApprovalStatus;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'UserSchemaClass',
  })
  savedById?: string;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'UserSchemaClass',
  })
  approvedById?: string;

  @Prop({ type: Date })
  approvedAt?: Date;

  @Prop({ type: String })
  rejectionReason?: string;

  @Prop({ type: String })
  changeNote?: string;
}

export const SocialContentAssetVersionSchema = SchemaFactory.createForClass(
  SocialContentAssetVersionSchemaClass,
);

SocialContentAssetVersionSchema.plugin(tenantFilterPlugin, {
  field: 'tenantId',
});
SocialContentAssetVersionSchema.index(
  { tenantId: 1, assetId: 1, versionNumber: -1 },
  { name: 'tenant_asset_version_lookup', unique: true },
);
SocialContentAssetVersionSchema.index(
  { tenantId: 1, assetId: 1, approvalStatus: 1 },
  { name: 'tenant_asset_version_approval_lookup' },
);
