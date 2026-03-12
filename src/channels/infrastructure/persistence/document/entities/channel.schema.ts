import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { EntityDocumentHelper } from '../../../../../utils/document-entity-helper';
import { tenantFilterPlugin } from '../../../../../common/plugins/tenant-filter.plugin';

export type ChannelSchemaDocument = HydratedDocument<ChannelSchemaClass>;

const CHANNEL_TYPES = [
  'Facebook',
  'Zalo',
  'WhatsApp',
  'LiveChat',
  'Instagram',
  'TikTok',
  'Shopee',
  'Email',
];

@Schema({
  timestamps: true,
  collection: 'channels',
  toJSON: { virtuals: true, getters: true },
})
export class ChannelSchemaClass extends EntityDocumentHelper {
  @Prop({
    type: String,
    ref: 'TenantSchemaClass',
    required: true,
    index: true,
  })
  tenant: string;

  @Prop({ required: true, enum: CHANNEL_TYPES })
  type: string;

  @Prop({ required: true })
  name: string;

  @Prop({ required: true })
  account: string;

  @Prop({
    required: true,
    enum: ['Connected', 'Disconnected', 'Error', 'Pending'],
    default: 'Pending',
  })
  status: string;

  @Prop({ type: MongooseSchema.Types.Mixed, default: {} })
  config: Record<string, any>;

  // Sensitive credentials — never returned in list API
  @Prop({ type: MongooseSchema.Types.Mixed, select: false })
  credentials: Record<string, any>;
}

export const ChannelSchema = SchemaFactory.createForClass(ChannelSchemaClass);

ChannelSchema.plugin(tenantFilterPlugin, { field: 'tenant' });
ChannelSchema.index({ tenant: 1, type: 1, account: 1 }, { unique: true });
