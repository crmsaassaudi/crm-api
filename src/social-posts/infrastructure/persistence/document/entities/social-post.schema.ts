import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { tenantFilterPlugin } from '../../../../../common/plugins/tenant-filter.plugin';
import { EntityDocumentHelper } from '../../../../../utils/document-entity-helper';
import {
  SOCIAL_CONTENT_ASSET_STATUSES,
  SocialContentAssetStatus,
} from '../../../../social-posts.types';

export type SocialContentAssetSchemaDocument =
  HydratedDocument<SocialContentAssetSchemaClass>;

@Schema({
  timestamps: true,
  collection: 'social_content_assets',
  toJSON: { virtuals: true, getters: true },
})
export class SocialContentAssetSchemaClass extends EntityDocumentHelper {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TenantSchemaClass',
    required: true,
    index: true,
    immutable: true,
  })
  tenantId: string;

  @Prop({ type: String, trim: true, default: '' })
  title: string;

  @Prop({
    type: String,
    enum: SOCIAL_CONTENT_ASSET_STATUSES,
    required: true,
    index: true,
    default: 'ACTIVE',
  })
  status: SocialContentAssetStatus;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'UserSchemaClass',
    immutable: true,
  })
  createdById?: string;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'SocialContentAssetVersionSchemaClass',
  })
  latestVersionId?: string;
}

export const SocialContentAssetSchema = SchemaFactory.createForClass(
  SocialContentAssetSchemaClass,
);

SocialContentAssetSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });
SocialContentAssetSchema.index(
  { tenantId: 1, status: 1, createdAt: -1 },
  { name: 'tenant_content_asset_status_lookup' },
);
