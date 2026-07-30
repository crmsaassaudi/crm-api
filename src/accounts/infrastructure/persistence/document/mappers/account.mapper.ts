import { Account } from '../../../../domain/account';
import { AccountSchemaClass } from '../entities/account.schema';
import { UserMapper } from '../../../../../users/infrastructure/persistence/document/mappers/user.mapper';

export class AccountMapper {
  static toDomain(raw: AccountSchemaClass): Account {
    const domainEntity = new Account();
    domainEntity.id = raw._id.toString();
    domainEntity.tenantId = raw.tenantId?.toString();
    domainEntity.name = raw.name;
    domainEntity.website = raw.website;
    domainEntity.industry = raw.industry;
    domainEntity.typeId = raw.typeId?.toString();
    domainEntity.emails = raw.emails ?? [];
    domainEntity.phones = raw.phones ?? [];
    domainEntity.taxId = raw.taxId;
    domainEntity.annualRevenue = raw.annualRevenue;
    domainEntity.numberOfEmployees = raw.numberOfEmployees;
    domainEntity.billingAddress = raw.billingAddress;
    domainEntity.shippingAddress = raw.shippingAddress;
    if (raw.ownerId) {
      domainEntity.ownerId =
        typeof raw.ownerId === 'string'
          ? raw.ownerId
          : (raw.ownerId as any)._id?.toString();
    }
    // Handle explicitly populated 'owner' virtual/aggregation field
    if ((raw as any).owner) {
      domainEntity.owner = UserMapper.toDomain((raw as any).owner);
    }

    domainEntity.orgUnitId = raw.orgUnitId ? raw.orgUnitId.toString() : null;
    domainEntity.createdById = raw.createdById?.toString();
    domainEntity.updatedById = raw.updatedById?.toString();
    domainEntity.statusId = raw.statusId?.toString();
    domainEntity.isArchived = raw.isArchived;
    domainEntity.nameKey = raw.nameKey;
    domainEntity.websiteDomain = raw.websiteDomain;
    domainEntity.taxIdKey = raw.taxIdKey;
    domainEntity.version = (raw as any).__v;
    domainEntity.customFields = raw.customFields;
    domainEntity.tags = raw.tags;
    if ((raw as any).accountStatus) {
      const s = (raw as any).accountStatus;
      domainEntity.accountStatus = {
        id: s._id?.toString(),
        label: s.label,
        apiName: s.apiName,
        color: s.color,
      };
    }
    if ((raw as any).accountType) {
      const s = (raw as any).accountType;
      domainEntity.accountType = {
        id: s._id?.toString(),
        name: s.name,
        apiName: s.apiName,
      };
    }
    domainEntity.createdAt = raw.createdAt;
    domainEntity.updatedAt = raw.updatedAt;
    domainEntity.deletedAt = raw.deletedAt;
    return domainEntity;
  }

  static toPersistence(domainEntity: Account): AccountSchemaClass {
    const persistenceEntity = new AccountSchemaClass();
    if (domainEntity.id) {
      persistenceEntity._id = domainEntity.id;
    }
    persistenceEntity.tenantId = domainEntity.tenantId;
    persistenceEntity.name = domainEntity.name;
    persistenceEntity.website = domainEntity.website;
    persistenceEntity.industry = domainEntity.industry;
    persistenceEntity.typeId = domainEntity.typeId;
    if (domainEntity.emails !== undefined)
      persistenceEntity.emails = domainEntity.emails;
    if (domainEntity.phones !== undefined)
      persistenceEntity.phones = domainEntity.phones;
    persistenceEntity.taxId = domainEntity.taxId;
    persistenceEntity.annualRevenue = domainEntity.annualRevenue;
    persistenceEntity.numberOfEmployees = domainEntity.numberOfEmployees;
    persistenceEntity.billingAddress = domainEntity.billingAddress;
    persistenceEntity.shippingAddress = domainEntity.shippingAddress;
    persistenceEntity.ownerId = domainEntity.ownerId;
    // Both are required by the schema, and `create()` builds the document directly so
    // inserts were fine. But `update()` writes only what this method emits — and the base
    // repository adds `updatedById` to every patch expecting the mapper to carry it — so
    // an account's "last changed by" stayed whoever created it, forever.
    if (domainEntity.createdById !== undefined) {
      persistenceEntity.createdById = domainEntity.createdById;
    }
    if (domainEntity.updatedById !== undefined) {
      persistenceEntity.updatedById = domainEntity.updatedById;
    }
    if (domainEntity.orgUnitId !== undefined)
      persistenceEntity.orgUnitId = domainEntity.orgUnitId;
    persistenceEntity.statusId = domainEntity.statusId;
    persistenceEntity.isArchived = domainEntity.isArchived;
    persistenceEntity.customFields = domainEntity.customFields;
    persistenceEntity.tags = domainEntity.tags;

    // Identity keys must round-trip, or `update()` drops the keys AccountsService
    // just derived and duplicate detection keeps comparing the pre-edit values.
    // `''` is a meaningful value here — it is how "this account no longer has a
    // usable key" is recorded — so these are copied whenever defined rather than
    // when truthy.
    if (domainEntity.nameKey !== undefined)
      persistenceEntity.nameKey = domainEntity.nameKey;
    if (domainEntity.websiteDomain !== undefined)
      persistenceEntity.websiteDomain = domainEntity.websiteDomain;
    if (domainEntity.taxIdKey !== undefined)
      persistenceEntity.taxIdKey = domainEntity.taxIdKey;

    // Only when the caller supplied one: `BaseDocumentRepository.update` turns a
    // present `__v` into an optimistic-concurrency filter, and an ordinary PATCH
    // must not start failing on a check nobody asked for.
    if (domainEntity.version !== undefined) {
      (persistenceEntity as any).__v = domainEntity.version;
    }

    return persistenceEntity;
  }
}
