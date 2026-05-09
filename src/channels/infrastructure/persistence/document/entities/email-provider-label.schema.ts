import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';

export type EmailProviderLabelDocument =
  HydratedDocument<EmailProviderLabelSchemaClass>;

@Schema({
  timestamps: true,
  collection: 'email_provider_labels',
  toJSON: { virtuals: true, getters: true },
})
export class EmailProviderLabelSchemaClass {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TenantSchemaClass',
    required: true,
    index: true,
  })
  tenantId: string;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'ChannelConfigSchemaClass',
    required: true,
    index: true,
  })
  mailboxId: string;

  @Prop({ required: true, index: true })
  provider: string;

  @Prop({ required: true })
  providerLabelId: string;

  @Prop({ required: true })
  name: string;

  @Prop({
    type: String,
    enum: ['system', 'user'],
    default: 'user',
    index: true,
  })
  type: 'system' | 'user';

  @Prop({ type: String, default: null })
  color: string | null;

  @Prop({ type: String, default: 'slate' })
  normalizedColor: string;

  @Prop({ type: Boolean, default: false, index: true })
  isDeleted: boolean;

  @Prop({ type: Date, default: null, index: true })
  lastSeenAt: Date | null;

  @Prop({ type: Number, default: 0 })
  usageCount: number;
}

export const EmailProviderLabelSchema = SchemaFactory.createForClass(
  EmailProviderLabelSchemaClass,
);

EmailProviderLabelSchema.index(
  { tenantId: 1, mailboxId: 1, provider: 1, providerLabelId: 1 },
  { unique: true },
);
EmailProviderLabelSchema.index({
  tenantId: 1,
  mailboxId: 1,
  isDeleted: 1,
  name: 1,
});
