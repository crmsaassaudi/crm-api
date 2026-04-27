import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { EntityDocumentHelper } from '../../utils/document-entity-helper';
import { tenantFilterPlugin } from '../../common/plugins/tenant-filter.plugin';

export type TicketSourceDocument = HydratedDocument<TicketSourceSchemaClass>;

@Schema({
  timestamps: true,
  collection: 'ticket_sources',
  toJSON: { virtuals: true, getters: true },
})
export class TicketSourceSchemaClass extends EntityDocumentHelper {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TenantSchemaClass',
    required: true,
    index: true,
  })
  tenantId: string;

  @Prop({ required: true })
  name: string;

  @Prop({ default: 0 })
  sortOrder: number;
}

export const TicketSourceSchema = SchemaFactory.createForClass(
  TicketSourceSchemaClass,
);
TicketSourceSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });
