import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';

export type OutboxEventDocument = HydratedDocument<OutboxEventSchemaClass>;

/**
 * Transactional Outbox for conversation-ops events.
 *
 * Events are written to this collection in the same MongoDB transaction
 * as the aggregate mutation. After commit, the processor publishes
 * them via EventEmitter (best-effort). A cron poller catches any events
 * that the in-process publisher missed (crash, timeout, etc.).
 */
@Schema({
  timestamps: false,
  collection: 'outbox_events',
})
export class OutboxEventSchemaClass {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    required: true,
    index: true,
  })
  conversationId: string;

  @Prop({ required: true, index: true })
  tenantId: string;

  /** Domain event type (e.g. 'omni.message.persisted', 'omni.conversation.created') */
  @Prop({ required: true })
  eventType: string;

  /** Serialized event payload — stored as Mixed for flexibility */
  @Prop({ type: MongooseSchema.Types.Mixed, required: true })
  payload: Record<string, any>;

  @Prop({
    type: String,
    enum: ['pending', 'published'],
    default: 'pending',
    index: true,
  })
  status: 'pending' | 'published';

  @Prop({ default: () => new Date() })
  createdAt: Date;

  @Prop({ type: Date, default: null })
  publishedAt: Date | null;
}

export const OutboxEventSchema = SchemaFactory.createForClass(
  OutboxEventSchemaClass,
);

// Poller query: find pending events oldest-first
OutboxEventSchema.index(
  { status: 1, createdAt: 1 },
  { name: 'outbox_pending_scan' },
);

// Auto-purge published events after 7 days to keep collection lean
OutboxEventSchema.index(
  { publishedAt: 1 },
  {
    expireAfterSeconds: 7 * 86_400,
    partialFilterExpression: { status: 'published' },
    name: 'outbox_published_ttl',
  },
);
