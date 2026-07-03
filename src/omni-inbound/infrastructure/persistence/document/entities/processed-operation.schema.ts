import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type ProcessedOperationDocument =
  HydratedDocument<ProcessedOperationSchemaClass>;

/**
 * Idempotency ledger for conversation-ops commands.
 *
 * Before executing any command, the processor inserts a record here.
 * If the insert succeeds (no duplicate key), the command is new.
 * If it fails with E11000, the command was already processed → skip.
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
