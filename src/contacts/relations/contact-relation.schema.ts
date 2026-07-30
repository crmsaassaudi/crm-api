import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, now } from 'mongoose';
import { EntityDocumentHelper } from '../../utils/document-entity-helper';
import { tenantFilterPlugin } from '../../common/plugins/tenant-filter.plugin';

export type ContactRelationDocument =
  HydratedDocument<ContactRelationSchemaClass>;

/**
 * Person↔person relationship types.
 *
 * `custom` exists so a tenant can express something this list does not cover
 * without a schema change; `customLabel` then carries the wording.
 */
export const CONTACT_RELATION_TYPES = [
  'reports_to',
  'referred_by',
  'colleague',
  'household',
  'assistant_of',
  'decision_maker_for',
  'custom',
] as const;

export type ContactRelationType = (typeof CONTACT_RELATION_TYPES)[number];

/**
 * The inverse of each type, so the graph reads correctly from either end.
 *
 * A relationship is stored ONCE, on one row, with a direction — not twice. Two
 * rows per relationship is the obvious design and the wrong one: the pair can
 * drift, deleting one leaves a half-edge, and merge has to reconcile both sides.
 * Instead `inverseOf` lets a read from the other contact render the same row with
 * the right wording: A `reports_to` B, so from B the same row is "direct report".
 */
export const INVERSE_RELATION_LABEL: Record<ContactRelationType, string> = {
  reports_to: 'direct_report',
  referred_by: 'referred',
  colleague: 'colleague',
  household: 'household',
  assistant_of: 'assisted_by',
  decision_maker_for: 'influenced_by',
  custom: 'custom',
};

/**
 * A relationship between two people.
 *
 * `Contact relationships` was in the audit's scope and did not exist at all: the
 * schema had no reports-to, no referred-by, no household, no influencer map.
 * Salesforce has `ContactContactRelation` plus `Contact.ReportsToId`, EspoCRM and
 * YetiForce both ship relation modules — this was the largest purely functional
 * gap against every benchmark.
 */
@Schema({ timestamps: true, collection: 'contact_relations' })
export class ContactRelationSchemaClass extends EntityDocumentHelper {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TenantSchemaClass',
    required: true,
    index: true,
  })
  tenantId: string;

  /** The subject: "`fromContactId` reports_to `toContactId`". */
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'ContactSchemaClass',
    required: true,
    index: true,
  })
  fromContactId: string;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'ContactSchemaClass',
    required: true,
    index: true,
  })
  toContactId: string;

  @Prop({
    type: String,
    required: true,
    enum: CONTACT_RELATION_TYPES,
    index: true,
  })
  relationType: ContactRelationType;

  /** Wording for `relationType: 'custom'`. Ignored otherwise. */
  @Prop()
  customLabel?: string;

  @Prop()
  notes?: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'UserSchemaClass' })
  createdById?: string;

  @Prop({ default: now })
  createdAt: Date;

  @Prop({ default: now })
  updatedAt: Date;

  /**
   * Soft delete, matching the contacts convention. A relationship removed by
   * mistake is otherwise unrecoverable, and the purge cascade needs something to
   * key on.
   */
  @Prop({ type: Date, default: null })
  deletedAt?: Date | null;
}

export const ContactRelationSchema = SchemaFactory.createForClass(
  ContactRelationSchemaClass,
);

ContactRelationSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });

// "Who is related to this person?" — asked from either end, so both directions
// need an index. A single compound index cannot serve both.
ContactRelationSchema.index(
  { tenantId: 1, fromContactId: 1, deletedAt: 1 },
  { name: 'tenant_from_contact' },
);
ContactRelationSchema.index(
  { tenantId: 1, toContactId: 1, deletedAt: 1 },
  { name: 'tenant_to_contact' },
);

// One live relationship of a given type per ordered pair. Partial so that
// soft-deleted rows do not block re-creating the same relationship later — which
// is exactly what a plain unique index would do, turning an undo into a dead end.
ContactRelationSchema.index(
  { tenantId: 1, fromContactId: 1, toContactId: 1, relationType: 1 },
  {
    name: 'tenant_unique_live_relation',
    unique: true,
    partialFilterExpression: { deletedAt: null },
  },
);
