import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { EntityDocumentHelper } from '../../../../../utils/document-entity-helper';
import { tenantFilterPlugin } from '../../../../../common/plugins/tenant-filter.plugin';

export type CannedResponseSchemaDocument =
  HydratedDocument<CannedResponseSchemaClass>;

@Schema({
  timestamps: true,
  collection: 'canned_responses',
  toJSON: { virtuals: true, getters: true },
})
export class CannedResponseSchemaClass extends EntityDocumentHelper {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TenantSchemaClass',
    required: true,
    index: true,
  })
  tenantId: string;

  @Prop({ required: true })
  shortcut: string;

  @Prop({ required: true })
  content: string;

  @Prop({ default: 'General' })
  category: string;

  @Prop({ required: true, enum: ['Public', 'Private', 'Team'] })
  scope: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'UserSchemaClass' })
  createdById: string;

  @Prop({ type: [String], default: [] })
  attachments: string[];
}

export const CannedResponseSchema = SchemaFactory.createForClass(
  CannedResponseSchemaClass,
);

CannedResponseSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });
CannedResponseSchema.index({ tenantId: 1, shortcut: 1 }, { unique: true });
