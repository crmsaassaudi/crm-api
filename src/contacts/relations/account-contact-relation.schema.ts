import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, now } from 'mongoose';
import { EntityDocumentHelper } from '../../utils/document-entity-helper';
import { tenantFilterPlugin } from '../../common/plugins/tenant-filter.plugin';

export type AccountContactRelationDocument =
  HydratedDocument<AccountContactRelationSchemaClass>;

/**
 * Many-to-many affiliation between a person and a company.
 *
 * The contact schema modelled this as a single `accountId` plus a free-text
 * `companyName`, which fails in three ways the audit set out: the two can
 * disagree with nothing reconciling them, a person cannot be a contact at two
 * companies, and a role cannot differ per company. Salesforce introduced
 * `AccountContactRelation` in 2016 for exactly this; HubSpot has labelled
 * multi-company associations; EspoCRM has `AccountContact` with a role.
 *
 * `contact.accountId` is NOT retired here. It is kept in sync with whichever
 * relation is `isPrimary`, so every existing query, report, export column and
 * automation condition that reads `accountId` keeps working unchanged. Removing
 * it is a separate migration; breaking those readers to introduce a feature would
 * be the wrong order.
 */
@Schema({ timestamps: true, collection: 'account_contact_relations' })
export class AccountContactRelationSchemaClass extends EntityDocumentHelper {
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

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'AccountSchemaClass',
    required: true,
    index: true,
  })
  accountId: string;

  /** Their role AT THIS COMPANY — the thing a single `contact.role` cannot express. */
  @Prop()
  role?: string;

  @Prop()
  title?: string;

  /**
   * The affiliation that `contact.accountId` mirrors. At most one live primary
   * per contact, enforced by a partial unique index below and by the service.
   */
  @Prop({ default: false, index: true })
  isPrimary: boolean;

  /** When the person joined. Optional — most tenants will not know it. */
  @Prop({ type: Date })
  startedAt?: Date;

  /**
   * When they left. A NULL end date means current; setting it is how a former
   * employee stops counting as a contact at that company without deleting the
   * history that they once were. That history is the point: "who used to work at
   * Acme" is a question a CRM should be able to answer.
   */
  @Prop({ type: Date, default: null })
  endedAt?: Date | null;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'UserSchemaClass' })
  createdById?: string;

  @Prop({ default: now })
  createdAt: Date;

  @Prop({ default: now })
  updatedAt: Date;

  @Prop({ type: Date, default: null })
  deletedAt?: Date | null;
}

export const AccountContactRelationSchema = SchemaFactory.createForClass(
  AccountContactRelationSchemaClass,
);

AccountContactRelationSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });

// "Which companies is this person affiliated with?"
AccountContactRelationSchema.index(
  { tenantId: 1, contactId: 1, deletedAt: 1 },
  { name: 'tenant_contact_affiliations' },
);
// "Who works at this company?" — the account detail page's contacts list.
AccountContactRelationSchema.index(
  { tenantId: 1, accountId: 1, deletedAt: 1 },
  { name: 'tenant_account_contacts' },
);

// One live affiliation per (contact, account) pair. Partial on `deletedAt` so a
// soft-deleted row does not permanently block re-affiliating the same pair.
AccountContactRelationSchema.index(
  { tenantId: 1, contactId: 1, accountId: 1 },
  {
    name: 'tenant_unique_live_affiliation',
    unique: true,
    partialFilterExpression: { deletedAt: null },
  },
);

// At most ONE primary affiliation per contact, as a database constraint rather
// than a service convention — `contact.accountId` mirrors it, so two primaries
// would make that mirror ambiguous and the mismatch would be silent.
AccountContactRelationSchema.index(
  { tenantId: 1, contactId: 1, isPrimary: 1 },
  {
    name: 'tenant_single_primary_affiliation',
    unique: true,
    partialFilterExpression: { isPrimary: true, deletedAt: null },
  },
);
