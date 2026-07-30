import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { EntityDocumentHelper } from '../../utils/document-entity-helper';
import { tenantFilterPlugin } from '../../common/plugins/tenant-filter.plugin';

export type ContactStageTransitionDocument =
  HydratedDocument<ContactStageTransitionSchemaClass>;

@Schema({ timestamps: false, collection: 'contact_stage_transitions' })
export class ContactStageTransitionSchemaClass extends EntityDocumentHelper {
  @Prop({ type: MongooseSchema.Types.ObjectId, required: true, index: true })
  tenantId: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, required: true, index: true })
  contactId: string;

  @Prop({ type: String, default: null })
  fromStage: string | null;

  @Prop({ type: String, required: true })
  toStage: string;

  @Prop({ type: Date, required: true })
  occurredAt: Date;

  @Prop({ type: MongooseSchema.Types.ObjectId })
  changedById?: string;

  @Prop()
  reason?: string;

  @Prop({ enum: ['forward', 'backward', 'lateral'] })
  direction?: 'forward' | 'backward' | 'lateral';

  @Prop({ type: [String], default: [] })
  skippedStages: string[];

  /** Stable id from the command, making listener retries idempotent. */
  @Prop({ required: true })
  eventId: string;
}

export const ContactStageTransitionSchema = SchemaFactory.createForClass(
  ContactStageTransitionSchemaClass,
);

ContactStageTransitionSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });
ContactStageTransitionSchema.index(
  { tenantId: 1, contactId: 1, occurredAt: -1, _id: -1 },
  { name: 'tenant_contact_stage_cursor' },
);
ContactStageTransitionSchema.index(
  { tenantId: 1, eventId: 1 },
  { name: 'tenant_unique_stage_event', unique: true },
);
