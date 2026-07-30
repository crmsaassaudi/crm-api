import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, now } from 'mongoose';
import { EntityDocumentHelper } from '../../utils/document-entity-helper';
import { tenantFilterPlugin } from '../../common/plugins/tenant-filter.plugin';

export type ContactMergeDocument = HydratedDocument<ContactMergeSchemaClass>;

export const CONTACT_MERGE_STATUSES = [
  'preparing',
  'reparenting',
  'completed',
  'failed',
  'compensating',
  'compensated',
  'reverting',
  'reverted',
] as const;
export type ContactMergeStatus = (typeof CONTACT_MERGE_STATUSES)[number];

export interface ContactMergeJournalDocument {
  id: string;
  /** Only used by array references: the survivor was already linked before merge. */
  targetPresentBefore?: boolean;
  /** Paired row was suppressed instead of re-parented to avoid self/unique conflict. */
  softDeletedDuringMerge?: boolean;
}

export interface ContactMergeJournalEntry {
  collection: string;
  field: string;
  kind: string;
  documents: ContactMergeJournalDocument[];
}

/**
 * Ledger of contact merges — one row per merge, written inside the merge itself.
 *
 * Merge is the most destructive routine operation in a CRM: it folds two people
 * into one, discards the loser's conflicting field values, and moves every
 * related record. Previously the only trace was a single `activity_logs` row
 * naming the two ids, which is not enough to answer either question a user asks
 * afterwards — "what did we lose?" and "can you undo it?".
 *
 * This ledger records the field-level choices and the re-parent counts, so the
 * merge is explainable, and enough of the loser's state to make an unmerge
 * possible: the loser document is soft-deleted rather than removed, and
 * `reparented` says exactly which rows moved and where from.
 */
@Schema({ timestamps: true, collection: 'contact_merges' })
export class ContactMergeSchemaClass extends EntityDocumentHelper {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TenantSchemaClass',
    required: true,
    index: true,
  })
  tenantId: string;

  /** The contact that survived and now holds the union of both records. */
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'ContactSchemaClass',
    required: true,
    index: true,
  })
  survivorId: string;

  /** The contact that was soft-deleted. */
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'ContactSchemaClass',
    required: true,
    index: true,
  })
  mergedId: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'UserSchemaClass' })
  performedById?: string;

  /** Durable saga state. A non-terminal row is repairable by an operator. */
  @Prop({
    type: String,
    enum: CONTACT_MERGE_STATUSES,
    default: 'preparing',
    index: true,
  })
  status: ContactMergeStatus;

  /** Last failed step/message; deliberately excludes record PII. */
  @Prop({ type: String })
  failureReason?: string;

  /**
   * Per-field survivorship outcome:
   * `{ field: { chosen, from: 'survivor'|'merged', discarded } }`.
   * `discarded` is what a user needs to see to trust — or contest — the merge.
   */
  @Prop({ type: MongooseSchema.Types.Mixed, default: {} })
  fieldChoices: Record<
    string,
    { chosen: unknown; from: 'survivor' | 'merged'; discarded?: unknown }
  >;

  /** `{ collection: rowsMoved }` — the receipt for the re-parent pass. */
  @Prop({ type: MongooseSchema.Types.Mixed, default: {} })
  reparented: Record<string, number>;

  /**
   * Exact records selected before mutation. Counts are useful for display, but
   * cannot safely compensate a merge: unmerge must never touch a survivor row
   * merely because it lives in the same collection.
   */
  @Prop({ type: MongooseSchema.Types.Mixed, default: [] })
  moveJournal: ContactMergeJournalEntry[];

  /** Full pre-merge snapshot of the loser, so an unmerge can restore it. */
  @Prop({ type: MongooseSchema.Types.Mixed })
  mergedSnapshot?: Record<string, unknown>;

  /** Set when the merge has been reversed; blocks a second unmerge. */
  @Prop({ type: Date, default: null })
  revertedAt?: Date | null;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'UserSchemaClass' })
  revertedById?: string;

  @Prop({ default: now })
  createdAt: Date;
}

export const ContactMergeSchema = SchemaFactory.createForClass(
  ContactMergeSchemaClass,
);

ContactMergeSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });
// "Show me this contact's merge history" — both directions, newest first.
ContactMergeSchema.index({ tenantId: 1, survivorId: 1, createdAt: -1 });
ContactMergeSchema.index({ tenantId: 1, mergedId: 1 });
ContactMergeSchema.index({ tenantId: 1, status: 1, createdAt: 1 });
