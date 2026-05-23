import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { EntityDocumentHelper } from '../../../../../utils/document-entity-helper';

export type AiVideoSettingsSchemaDocument =
  HydratedDocument<AiVideoSettingsSchemaClass>;

@Schema({
  timestamps: true,
  collection: 'ai_video_settings',
})
export class AiVideoSettingsSchemaClass extends EntityDocumentHelper {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TenantSchemaClass',
    required: true,
    index: true,
    unique: true,
    immutable: true,
  })
  tenantId: MongooseSchema.Types.ObjectId;

  @Prop({ type: Number, default: 30 })
  retainOriginalDays: number;

  @Prop({ type: Number, default: 180 })
  retainProcessedDays: number;

  @Prop({ type: Boolean, default: true })
  autoCleanupTempFiles: boolean;

  @Prop({ type: String })
  elevenLabsApiKey?: string;

  @Prop({ type: String, default: '21m00Tcm4TlvDq8ikWAM' }) // Default Vietnamese/English premium voice Rachel
  defaultVoiceId: string;

  @Prop({ type: Number, default: 0.15 })
  bgmVolume: number;
}

export const AiVideoSettingsSchema = SchemaFactory.createForClass(
  AiVideoSettingsSchemaClass,
);
