import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { EntityDocumentHelper } from '../../utils/document-entity-helper';
import { tenantFilterPlugin } from '../../common/plugins/tenant-filter.plugin';

export type TicketStatusDocument = HydratedDocument<TicketStatusSchemaClass>;

@Schema({
  timestamps: true,
  collection: 'ticket_statuses',
  toJSON: { virtuals: true, getters: true },
})
export class TicketStatusSchemaClass extends EntityDocumentHelper {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TenantSchemaClass',
    required: true,
    index: true,
  })
  tenantId: string;

  @Prop({ required: true })
  label: string;

  @Prop({ required: true })
  apiName: string;

  @Prop({ default: '#3b82f6' })
  color: string;

  @Prop({ default: 0 })
  sortOrder: number;

  @Prop({ default: false })
  isDefault: boolean;

  @Prop({ default: false })
  isTerminal: boolean;
}

export const TicketStatusSchema = SchemaFactory.createForClass(
  TicketStatusSchemaClass,
);
TicketStatusSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });
TicketStatusSchema.index({ tenantId: 1, apiName: 1 }, { unique: true });
TicketStatusSchema.index({ tenantId: 1, sortOrder: 1 });
