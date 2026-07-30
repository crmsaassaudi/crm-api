import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, now } from 'mongoose';
import { EntityDocumentHelper } from '../../utils/document-entity-helper';
import { tenantFilterPlugin } from '../../common/plugins/tenant-filter.plugin';

export type ContactMergeDocument = HydratedDocument<ContactMergeSchemaClass>;

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
