import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { EntityDocumentHelper } from '../../../../../utils/document-entity-helper';

/**
 * NOT YET WIRED. No repository, mapper or service touches this collection — see the
 * note on the `AiVideoAsset` domain class. Registering it in `ai-video.module.ts` is
 * what makes Mongoose build and maintain its indexes, so the cost of the unfinished
 * feature is paid in every environment on every boot.
 */
export type AiVideoAssetSchemaDocument =
  HydratedDocument<AiVideoAssetSchemaClass>;

@Schema({
  timestamps: true,
  collection: 'ai_video_assets',
})
export class AiVideoAssetSchemaClass extends EntityDocumentHelper {
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

  @Prop({
    type: String,
    required: true,
    enum: ['original', 'normalized', 'processed', 'thumbnail', 'subtitle'],
  })
  type: string;

  @Prop({ type: String })
  url?: string;

  @Prop({ type: String })
  storageKey?: string;

  @Prop({ type: Number })
  duration?: number;

  @Prop({ type: Number })
  size?: number;

  @Prop({ type: String })
  mimeType?: string;

  @Prop({ type: String })
  resolution?: string;

  @Prop({ type: String })
  checksum?: string;

  @Prop({ type: MongooseSchema.Types.Mixed })
  metadata?: Record<string, any>;
}

export const AiVideoAssetSchema = SchemaFactory.createForClass(
  AiVideoAssetSchemaClass,
);

AiVideoAssetSchema.index(
  { tenantId: 1, jobId: 1, type: 1 },
  { name: 'tenant_job_type_lookup' },
);
