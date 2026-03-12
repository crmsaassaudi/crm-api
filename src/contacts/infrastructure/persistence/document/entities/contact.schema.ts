import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, now } from 'mongoose';
import { EntityDocumentHelper } from '../../../../../utils/document-entity-helper';
import { tenantFilterPlugin } from '../../../../../common/plugins/tenant-filter.plugin';

export type ContactSchemaDocument = HydratedDocument<ContactSchemaClass>;

@Schema({
  timestamps: true,
  collection: 'contacts',
  toJSON: {
    virtuals: true,
    getters: true,
    transform: (doc, ret: any) => {
      ret.version = ret.__v;
      delete ret.__v;
      return ret;
    },
  },
})
export class ContactSchemaClass extends EntityDocumentHelper {
  @Prop({ type: String, ref: 'TenantSchemaClass', required: true, index: true })
  tenant: string;

  @Prop({ required: true, index: true })
  firstName: string;

  @Prop({ required: true, index: true })
  lastName: string;

  @Prop({ type: [String], default: [] })
  emails: string[];

  @Prop({ type: [String], default: [] })
  phones: string[];

  @Prop({ default: false })
  isConverted: boolean;

  @Prop({ required: true, index: true })
  lifecycleStage: string;

  @Prop({ required: true, index: true })
  status: string;

  @Prop()
  companyName?: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'AccountSchemaClass' })
  account?: string;

  @Prop()
  title?: string;

  @Prop()
  source?: string;

  @Prop({ default: 0 })
  score?: number;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'UserSchemaClass' })
  owner?: string;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'UserSchemaClass',
    required: true,
  })
  createdBy: string;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'UserSchemaClass',
    required: true,
  })
  updatedBy: string;

  @Prop({ default: now })
  createdAt: Date;

  @Prop({ default: now })
  updatedAt: Date;

  @Prop()
  deletedAt?: Date;
}

export const ContactSchema = SchemaFactory.createForClass(ContactSchemaClass);

ContactSchema.plugin(tenantFilterPlugin, { field: 'tenant' });
ContactSchema.index({ tenant: 1, emails: 1 });
ContactSchema.index({ tenant: 1, firstName: 1, lastName: 1 });
