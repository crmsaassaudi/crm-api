import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { tenantFilterPlugin } from '../../../../../common/plugins/tenant-filter.plugin';

export type OutboxEventDocument = HydratedDocument<OutboxEventSchemaClass>;

/**
 * Outbox for conversation-ops events.
 *
 * What actually makes this durable
 * --------------------------------
 * This docblock used to claim the row was written "in the same MongoDB
 * transaction as the aggregate mutation". It is not, and never was — the
 * processor writes the aggregate, then calls `outboxModel.create()` with no
 * session. Two writes, no transaction.
 *
 * The guarantee is real, but it comes from somewhere else, and saying the wrong
 * thing here is how the next person concludes there is a data-loss hole (or,
 * worse, removes the thing that is actually holding it up):
 *
 *   1. Every command runs inside a BullMQ job, and `ConversationOpsProcessor`
 *      marks the operation `completedAt` **last** — after both the aggregate
 *      write and the outbox write.
 *   2. A crash between the two therefore leaves `completedAt` unset, and the
 *      job is retried. `claimOperation` only short-circuits on `completedAt`,
 *      so the retry re-runs the handler and the outbox row is written then.
 *   3. Publication is separate and best-effort: rows stay `pending` until a
 *      listener has actually finished, and `OutboxPublisherService` polls for
 *      the ones that never got there.
 *
 * So the transaction boundary is the *job*, not a database transaction. The
 * ordering in (1) is load-bearing and is pinned by
 * `conversation-ops.outbox-durability.spec.ts`: move `completeOperation` above
 * the outbox write and a crash really would lose the event.
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

  /** Domain event type (e.g. 'omni.message.persisted', 'omni.conversation.created') */
  @Prop({ required: true })
  eventType: string;

  /** Serialized event payload — stored as Mixed for flexibility */
  @Prop({ type: MongooseSchema.Types.Mixed, required: true })
  payload: Record<string, any>;

  @Prop({
    type: String,
    enum: ['pending', 'published', 'failed'],
    default: 'pending',
    index: true,
  })
  status: 'pending' | 'published' | 'failed';

  @Prop({ type: Number, default: 0 })
  retryCount: number;

  /**
   * When a recovery run took ownership of this event.
   *
   * The poller is registered on more than one runtime, so without a claim two
   * replicas publish the same pending event. The claim expires so a replica
   * that dies mid-publish does not strand it.
   */
  @Prop({ type: Date, default: null })
  claimedAt: Date | null;

  @Prop({ type: String, default: null })
  lastError: string | null;

  @Prop({ default: () => new Date() })
  createdAt: Date;

  @Prop({ type: Date, default: null })
  publishedAt: Date | null;
}

export const OutboxEventSchema = SchemaFactory.createForClass(
  OutboxEventSchemaClass,
);

// This was the only collection in the system without the tenant filter, so
// every query against it was cross-tenant by default rather than by decision.
// Nothing was leaking today — the two readers are the ops processor, which
// looks up by `_id`, and the poller, which is deliberately cross-tenant — but
// "safe because of who happens to call it" is not a property a schema can
// keep. The poller now says so explicitly with `isPlatformQuery`, which is the
// same opt-in every other cross-tenant cron uses.
OutboxEventSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });

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
