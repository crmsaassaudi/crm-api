import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { EntityDocumentHelper } from '../../../../../utils/document-entity-helper';
import { tenantFilterPlugin } from '../../../../../common/plugins/tenant-filter.plugin';
import { AutomationEventPayload } from '../../../../events/automation-event.payload';

export type AutomationOutboxEventDocument =
  HydratedDocument<AutomationOutboxEventSchemaClass>;

@Schema({
  timestamps: true,
  collection: 'automation_outbox_events',
})
export class AutomationOutboxEventSchemaClass extends EntityDocumentHelper {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TenantSchemaClass',
    required: true,
  })
  tenantId: string;

  /**
   * The shape of `payload`, so a consumer can tell which contract it is reading.
   *
   * One line, added while the outbox is empty. After go-live the same change
   * costs a dual-read path and a backfill over every pending row — and the
   * moment it is actually needed is the moment a payload has to change, which
   * is the worst moment to be adding a version field.
   */
  @Prop({ type: Number, required: true, default: 1 })
  schemaVersion: number;

  @Prop({ type: String, required: true })
  eventId: string;

  @Prop({ type: String, required: true })
  eventType: string;

  @Prop({ type: String, required: true })
  aggregateId: string;

  @Prop({ type: MongooseSchema.Types.Mixed, required: true })
  payload: AutomationEventPayload;

  @Prop({
    type: String,
    enum: ['pending', 'publishing', 'published', 'failed'],
    default: 'pending',
  })
  status: 'pending' | 'publishing' | 'published' | 'failed';

  @Prop({ type: Number, default: 0 })
  retryCount: number;

  @Prop({ type: String, default: null })
  lastError?: string | null;

  @Prop({ type: Date, default: null })
  publishedAt?: Date | null;
}

export const AutomationOutboxEventSchema = SchemaFactory.createForClass(
  AutomationOutboxEventSchemaClass,
);

AutomationOutboxEventSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });
AutomationOutboxEventSchema.index(
  { tenantId: 1, eventId: 1 },
  { unique: true, name: 'automation_outbox_event_unique' },
);
AutomationOutboxEventSchema.index(
  { status: 1, createdAt: 1 },
  { name: 'automation_outbox_pending' },
);
AutomationOutboxEventSchema.index(
  { publishedAt: 1 },
  {
    expireAfterSeconds: 7 * 86_400,
    partialFilterExpression: { status: 'published' },
    name: 'automation_outbox_published_ttl',
  },
);
