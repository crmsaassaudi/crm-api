import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { EntityDocumentHelper } from '../../utils/document-entity-helper';
import { tenantFilterPlugin } from '../../common/plugins/tenant-filter.plugin';

export type TicketResolutionCodeDocument =
  HydratedDocument<TicketResolutionCodeSchemaClass>;

@Schema({
  timestamps: true,
  collection: 'ticket_resolution_codes',
  toJSON: { virtuals: true, getters: true },
})
export class TicketResolutionCodeSchemaClass extends EntityDocumentHelper {
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
}

export const TicketResolutionCodeSchema = SchemaFactory.createForClass(
  TicketResolutionCodeSchemaClass,
);
TicketResolutionCodeSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });
TicketResolutionCodeSchema.index({ tenantId: 1, apiName: 1 }, { unique: true });
