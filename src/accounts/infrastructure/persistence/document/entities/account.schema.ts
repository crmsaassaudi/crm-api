import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, now } from 'mongoose';
import { EntityDocumentHelper } from '../../../../../utils/document-entity-helper';
import { tenantFilterPlugin } from '../../../../../common/plugins/tenant-filter.plugin';

export type AccountSchemaDocument = HydratedDocument<AccountSchemaClass>;

@Schema({
  timestamps: true,
  collection: 'accounts',
  toJSON: {
    virtuals: true,
    getters: true,
  },
})
export class AccountSchemaClass extends EntityDocumentHelper {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TenantSchemaClass',
    required: true,
    index: true,
  })
  tenantId: string;

  @Prop({ required: true, index: true })
  name: string;

  @Prop()
  website?: string;

  @Prop({ index: true })
  industry?: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'AccountTypeSchemaClass' })
  typeId?: string;

  @Prop({ type: [String], default: [] })
  emails?: string[];

  @Prop({ type: [String], default: [] })
  phones?: string[];

  @Prop()
  taxId?: string;

  @Prop({ type: Number })
  annualRevenue?: number;

  @Prop({ type: Number })
  numberOfEmployees?: number;

  @Prop()
  billingAddress?: string;

  @Prop()
  shippingAddress?: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'UserSchemaClass' })
  ownerId?: string;

  // Org-unit ownership: the node of the tenant's org tree this record belongs
  // to. Populated at create time from the record owner's org unit; read by the
  // 'org_unit' and 'org_unit_subtree' data scopes.
  @Prop({ type: MongooseSchema.Types.ObjectId, default: null, index: true })
  orgUnitId?: string | null;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'AccountStatusSchemaClass',
    index: true,
  })
  statusId?: string;

  @Prop({ default: false })
  isArchived?: boolean;

  // ── Derived identity keys ──
  //
  // Stored rather than computed per query so duplicate lookups are exact and indexed.
  // Written by AccountsService from `common/identity/company-identity`, which is the
  // single definition of how a company name / domain / tax id is compared — the same
  // reason contact emails are normalised at the edge rather than at compare time.
  //
  // These are comparison keys, not display values: `name`, `website` and `taxId` remain
  // exactly as the user entered them.

  /** Weak signal: legal-form suffixes and diacritics stripped. See the module comment. */
  @Prop({ index: true })
  nameKey?: string;

  /** Strong signal: the registrable domain of `website`. */
  @Prop({ index: true })
  websiteDomain?: string;

  /** Exact signal: `taxId` with formatting removed. */
  @Prop({ index: true })
  taxIdKey?: string;

  @Prop({ type: MongooseSchema.Types.Mixed })
  customFields?: Record<string, any>;

  @Prop({ type: [String], default: [] })
  tags?: string[];

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'UserSchemaClass',
    required: true,
  })
  createdById: string;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'UserSchemaClass',
    required: true,
  })
  updatedById: string;

  @Prop({ default: now })
  createdAt: Date;

  @Prop({ default: now })
  updatedAt: Date;

  @Prop()
  deletedAt?: Date;
}

export const AccountSchema = SchemaFactory.createForClass(AccountSchemaClass);

AccountSchema.plugin(tenantFilterPlugin, { field: 'tenantId' });
AccountSchema.index(
  { tenantId: 1, ownerId: 1 },
  { name: 'tenant_owner_lookup' },
);
AccountSchema.index(
  { tenantId: 1, statusId: 1 },
  { name: 'tenant_status_lookup' },
);
AccountSchema.index({ tenantId: 1, typeId: 1 }, { name: 'tenant_type_lookup' });
// Duplicate detection. Sparse: most accounts will have a name key, far fewer a tax id,
// and an index entry for every absent value is pure overhead.
AccountSchema.index(
  { tenantId: 1, taxIdKey: 1 },
  { name: 'tenant_tax_id_lookup', sparse: true },
);
AccountSchema.index(
  { tenantId: 1, websiteDomain: 1 },
  { name: 'tenant_domain_lookup', sparse: true },
);
AccountSchema.index(
  { tenantId: 1, nameKey: 1 },
  { name: 'tenant_name_key_lookup', sparse: true },
);
AccountSchema.index(
  { tenantId: 1, createdAt: -1, _id: -1 },
  { name: 'tenant_created_cursor' },
);

AccountSchema.virtual('owner', {
  ref: 'UserSchemaClass',
  localField: 'ownerId',
  foreignField: '_id',
  justOne: true,
});

AccountSchema.virtual('accountStatus', {
  ref: 'AccountStatusSchemaClass',
  localField: 'statusId',
  foreignField: '_id',
  justOne: true,
});

AccountSchema.virtual('accountType', {
  ref: 'AccountTypeSchemaClass',
  localField: 'typeId',
  foreignField: '_id',
  justOne: true,
});
