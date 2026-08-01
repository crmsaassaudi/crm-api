import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type ProcessedOperationDocument =
  HydratedDocument<ProcessedOperationSchemaClass>;

/**
 * Idempotency ledger for conversation-ops commands.
 *
 * A record is *claimed* when the command starts and *completed* when it
 * finishes. Only `completedAt` suppresses a replay.
 *
 * Treating the claim itself as "already processed" — the previous behaviour —
 * turned every retry into a silent no-op: a command that failed halfway left
 * its record behind, the retry saw it, returned early and logged success, and
 * the message was never persisted or dead-lettered.
 *
 * A record only ever reappears as a retry of the same job, because the
 * operationId is minted per enqueue and used as the BullMQ job id. So an
 * incomplete record always means "resume", never "someone else is running".
 *
 * TTL index auto-purges records after 30 days.
 */
@Schema({
  timestamps: false,
  collection: 'processed_operations',
})
export class ProcessedOperationSchemaClass {
  /** ULID — globally unique operation identifier from the command envelope. */
  @Prop({ required: true, unique: true, index: true })
  operationId: string;

  @Prop({ required: true, index: true })
  conversationId: string;

  @Prop({ required: true, index: true })
  tenantId: string;

  /**
   * Per-conversation ordinal allocated once, on the first attempt.
   *
   * Held here rather than re-allocated per attempt so a retry reuses the same
   * ordinal — otherwise a replayed message would be ordered after messages that
   * arrived while it was failing.
   */
  @Prop({ type: Number, default: null })
  sequence: number | null;

  /** Set when the command finished. Until then the command may be retried. */
  @Prop({ type: Date, default: null })
  completedAt: Date | null;

  @Prop({ default: () => new Date() })
  processedAt: Date;
}

export const ProcessedOperationSchema = SchemaFactory.createForClass(
  ProcessedOperationSchemaClass,
);

// Auto-purge after 30 days — sufficient for any real-world retry scenario
ProcessedOperationSchema.index(
  { processedAt: 1 },
  { expireAfterSeconds: 30 * 86_400, name: 'processed_ops_ttl' },
);
