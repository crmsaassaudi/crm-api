import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { EntityDocumentHelper } from '../../../utils/document-entity-helper';
import { tenantFilterPlugin } from '../../../common/plugins/tenant-filter.plugin';

export type AssignmentOutboxEventDocument =
  HydratedDocument<AssignmentOutboxEventSchemaClass>;

@Schema({
  timestamps: true,
  collection: 'assignment_outbox_events',
})
export class AssignmentOutboxEventSchemaClass extends EntityDocumentHelper {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TenantSchemaClass',
    required: true,
  })
  tenantId: string;

  @Prop({ type: String, required: true })
  eventId: string;

  @Prop({ type: String, required: true })
  eventType: string;

  @Prop({ type: String, required: true })
  aggregateId: string;

  @Prop({ type: MongooseSchema.Types.Mixed, required: true })
  payload: Record<string, any>;

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

export const AssignmentOutboxEventSchema = SchemaFactory.createForClass(
  AssignmentOutboxEventSchemaClass,
);
AssignmentOutboxEventSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });
AssignmentOutboxEventSchema.index(
  { tenantId: 1, eventId: 1 },
  { unique: true, name: 'assignment_outbox_event_unique' },
);
AssignmentOutboxEventSchema.index(
  { status: 1, createdAt: 1 },
  { name: 'assignment_outbox_pending' },
);
