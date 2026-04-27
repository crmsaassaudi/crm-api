import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { EntityDocumentHelper } from '../../utils/document-entity-helper';
import { tenantFilterPlugin } from '../../common/plugins/tenant-filter.plugin';

export type TicketTypeDocument = HydratedDocument<TicketTypeSchemaClass>;

@Schema({
  timestamps: true,
  collection: 'ticket_types',
  toJSON: { virtuals: true, getters: true },
})
export class TicketTypeSchemaClass extends EntityDocumentHelper {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TenantSchemaClass',
    required: true,
    index: true,
  })
  tenantId: string;

  @Prop({ required: true })
  name: string;

  @Prop({ required: true })
  apiName: string;

  @Prop()
  description?: string;

  @Prop({ default: '#3b82f6' })
  color: string;

  @Prop({ default: 0 })
  sortOrder: number;
}

export const TicketTypeSchema = SchemaFactory.createForClass(
  TicketTypeSchemaClass,
);
TicketTypeSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });
TicketTypeSchema.index({ tenantId: 1, apiName: 1 }, { unique: true });
