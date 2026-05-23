import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { tenantFilterPlugin } from '../../../../../common/plugins/tenant-filter.plugin';
import { EntityDocumentHelper } from '../../../../../utils/document-entity-helper';
import {
  SOCIAL_POST_MEDIA_TYPES,
  SocialPostMediaType,
} from '../../../../social-posts.types';

export type SocialPostVersionSchemaDocument = HydratedDocument<SocialPostVersionSchemaClass>;

@Schema({
  timestamps: true,
  collection: 'social_post_versions',
  toJSON: { virtuals: true, getters: true },
})
export class SocialPostVersionSchemaClass extends EntityDocumentHelper {
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
    ref: 'SocialPostSchemaClass',
    required: true,
    immutable: true,
    index: true,
  })
  postId: string;

  @Prop({ type: Number, required: true })
  versionNumber: number; // 1, 2, 3 ... auto-increment

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
    type: MongooseSchema.Types.ObjectId,
    ref: 'UserSchemaClass',
  })
  savedById?: string;

  @Prop({ type: String })
  changeNote?: string;
}

export const SocialPostVersionSchema = SchemaFactory.createForClass(
  SocialPostVersionSchemaClass,
);

SocialPostVersionSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });
SocialPostVersionSchema.index(
  { tenantId: 1, postId: 1, versionNumber: -1 },
  { name: 'tenant_post_version_lookup', unique: true },
);
