import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, now } from 'mongoose';
import { EntityDocumentHelper } from '../../utils/document-entity-helper';
import { tenantFilterPlugin } from '../../common/plugins/tenant-filter.plugin';

export type ContactIdentityDocument =
  HydratedDocument<ContactIdentitySchemaClass>;

export const CONTACT_IDENTITY_TYPES = ['email', 'phone', 'omni'] as const;
export type ContactIdentityType = (typeof CONTACT_IDENTITY_TYPES)[number];

/**
 * One reachable identity of a contact: an email address, a phone number, or a
 * messaging-channel account.
 *
 * The audit's §4.2 asked for three things the `emails[]` / `phones[]` /
 * `omniIdentities[]` arrays structurally cannot provide:
 *
 * 1. **A real uniqueness constraint.** `assertIdentityIsUnique` in ContactsService
 *    is a read-then-write check with no index behind it, because a unique index on
 *    an array field is per-element across the whole collection and cannot be scoped
 *    to a tenant. Two concurrent creates both pass the check and both write. As
 *    separate documents, `(tenantId, type, normalisedValue)` is an ordinary unique
 *    index and the race stops existing.
 * 2. **Per-identity state.** `verified`, `isPrimary`, `source`, `addedAt` — "which
 *    phone should we actually call" and "this address bounced" are not expressible
 *    in a bare string array.
 * 3. **Per-identity consent.** Opt-in was a single boolean per contact per channel,
 *    so a contact with two email addresses could not opt out of one. Consent
 *    attaches to an identity, not to a person; under GDPR/PDPL the contact-level
 *    flag is not defensible.
 *
 * ── Deliberately additive ──
 *
 * `contact.emails[]` / `phones[]` / `omniIdentities[]` remain AUTHORITATIVE for
 * reads. Every list view, export column, report, automation condition, dedup
 * lookup and omni resolver reads them and knows nothing about this collection;
 * flipping the read path in the same change that introduces the write path would
 * turn a schema addition into a migration of the entire domain.
 *
 * So this collection is written alongside the arrays and kept in sync from them.
 * That buys the unique index, the per-identity metadata and the consent model now,
 * and leaves the array retirement — and with it the last of M-4's lost-update
 * window — as a separate, reversible cutover.
 */
@Schema({ timestamps: true, collection: 'contact_identities' })
export class ContactIdentitySchemaClass extends EntityDocumentHelper {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TenantSchemaClass',
    required: true,
    index: true,
  })
  tenantId: string;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'ContactSchemaClass',
    required: true,
    index: true,
  })
  contactId: string;

  @Prop({ type: String, required: true, enum: CONTACT_IDENTITY_TYPES })
  type: ContactIdentityType;

  /**
   * The comparison key: lower-cased email, E.164 phone, or `channel:senderId`.
   * Produced by `common/identity/identity-normalizer` — the same gate every write
   * path passes through, which is what makes values from the UI, an import and a
   * webhook comparable at all.
   */
  @Prop({ required: true })
  normalisedValue: string;

  /**
   * Exactly what was supplied. Kept because normalisation is lossy for display —
   * `+84 90 111 2222` is what a user typed and recognises, `+84901112222` is what we
   * compare on. Showing them only the compacted form reads as data corruption.
   */
  @Prop({ required: true })
  rawValue: string;

  /** For `type: 'omni'` — 'facebook', 'zalo', … */
  @Prop()
  channelType?: string;

  /** The one to use when a contact has several of this type. */
  @Prop({ default: false })
  isPrimary: boolean;

  /**
   * Confirmed reachable — a click-through, a reply, a successful send. Distinct from
   * merely recorded: an address typed into a form has never been verified.
   */
  @Prop({ default: false })
  verified: boolean;

  /** Set when a send hard-bounced, so the next campaign skips it. */
  @Prop({ type: Date, default: null })
  bouncedAt?: Date | null;

  /**
   * Per-identity consent. `null` means "no explicit answer recorded", which is NOT
   * the same as `false` (an explicit refusal) — collapsing the two is how a system
   * ends up unable to prove it had permission.
   */
  @Prop({ type: Boolean, default: null })
  optIn?: boolean | null;

  @Prop({ type: Date, default: null })
  optInAt?: Date | null;

  /** Where it came from: 'manual', 'import', 'omni:facebook', 'livechat', … */
  @Prop()
  source?: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'UserSchemaClass' })
  createdById?: string;

  @Prop({ default: now })
  createdAt: Date;

  @Prop({ default: now })
  updatedAt: Date;

  @Prop({ type: Date, default: null })
  deletedAt?: Date | null;
}

export const ContactIdentitySchema = SchemaFactory.createForClass(
  ContactIdentitySchemaClass,
);

ContactIdentitySchema.plugin(tenantFilterPlugin, { field: 'tenantId' });

/**
 * The constraint this collection exists for.
 *
 * Partial on `deletedAt: null` so a removed identity does not permanently reserve
 * its own value — a plain unique index would make "delete an email, then add it back"
 * impossible, turning an undo into a dead end.
 *
 * NOTE: enforcement here is unconditional, while the tenant setting `uniqueEmail`
 * can be switched off. So the index covers `(tenantId, type, normalisedValue)` — a
 * value may not be shared between two CONTACTS in a tenant — which is the invariant
 * the setting actually expresses. A tenant that disables the setting still cannot
 * create two contacts sharing an address; it can only skip the pre-flight check and
 * get a clear conflict instead.
 */
ContactIdentitySchema.index(
  { tenantId: 1, type: 1, normalisedValue: 1 },
  {
    name: 'tenant_unique_identity',
    unique: true,
    partialFilterExpression: { deletedAt: null },
  },
);

// "What are this contact's identities?" — the detail page and the mirror sync.
ContactIdentitySchema.index(
  { tenantId: 1, contactId: 1, deletedAt: 1 },
  { name: 'tenant_contact_identities' },
);

// "Who owns this address / number / channel account?" — the resolver's hot path.
ContactIdentitySchema.index(
  { tenantId: 1, normalisedValue: 1 },
  { name: 'tenant_identity_lookup' },
);

// At most one primary per (contact, type), as a constraint rather than a convention.
ContactIdentitySchema.index(
  { tenantId: 1, contactId: 1, type: 1, isPrimary: 1 },
  {
    name: 'tenant_single_primary_identity',
    unique: true,
    partialFilterExpression: { isPrimary: true, deletedAt: null },
  },
);
