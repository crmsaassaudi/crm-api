import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { EntityDocumentHelper } from '../../../../../utils/document-entity-helper';

export type AiVideoJobSchemaDocument = HydratedDocument<AiVideoJobSchemaClass>;

@Schema({
  timestamps: true,
  collection: 'ai_video_jobs',
})
export class AiVideoJobSchemaClass extends EntityDocumentHelper {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TenantSchemaClass',
    required: true,
    index: true,
    immutable: true,
  })
  tenantId: MongooseSchema.Types.ObjectId;

  @Prop({ type: String, required: true, immutable: true })
  sourceType: 'manual_upload' | 'url_import' | 'script_production';

  @Prop({ type: String })
  sourceUrl?: string;

  @Prop({ type: String })
  scriptText?: string;

  @Prop({ type: String, required: true, index: true, default: 'CREATED' })
  status: string;

  @Prop({ type: MongooseSchema.Types.ObjectId })
  recipeId?: MongooseSchema.Types.ObjectId;

  @Prop({ type: String })
  facebookPageId?: string;

  @Prop({ type: String })
  caption?: string;

  @Prop({ type: [String], default: [] })
  hashtags: string[];

  @Prop({ type: Date })
  scheduledAt?: Date;

  @Prop({ type: Date })
  publishedAt?: Date;

  @Prop({ type: String })
  platformVideoId?: string;

  @Prop({ type: String })
  platformPostId?: string;

  @Prop({ type: String })
  errorDetails?: string;

  @Prop({ type: String })
  rejectReason?: string;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'UserSchemaClass',
    immutable: true,
  })
  createdById?: MongooseSchema.Types.ObjectId;
}

export const AiVideoJobSchema = SchemaFactory.createForClass(
  AiVideoJobSchemaClass,
);

// ── Compound indexes for dashboard queries & scheduler worker ──
AiVideoJobSchema.index(
  { tenantId: 1, status: 1, createdAt: -1 },
  { name: 'tenant_status_created_lookup' },
);
AiVideoJobSchema.index(
  { tenantId: 1, status: 1, scheduledAt: 1 },
  { name: 'tenant_status_scheduled_lookup' },
);
AiVideoJobSchema.index(
  { tenantId: 1, facebookPageId: 1, createdAt: -1 },
  { name: 'tenant_page_created_lookup' },
);
