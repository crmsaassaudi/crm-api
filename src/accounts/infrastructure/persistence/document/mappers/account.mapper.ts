import { Account } from '../../../../domain/account';
import { AccountSchemaClass } from '../entities/account.schema';
import { UserMapper } from '../../../../../users/infrastructure/persistence/document/mappers/user.mapper';

export class AccountMapper {
  static toDomain(raw: AccountSchemaClass): Account {
    const domainEntity = new Account();
    domainEntity.id = raw._id.toString();
    domainEntity.tenantId = raw.tenantId;
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
      domainEntity.owner = UserMapper.toDomain((raw as any).owner as any);
    }
    domainEntity.statusId = raw.statusId?.toString();
    domainEntity.isArchived = raw.isArchived;
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
    persistenceEntity.emails = domainEntity.emails ?? [];
    persistenceEntity.phones = domainEntity.phones ?? [];
    persistenceEntity.taxId = domainEntity.taxId;
    persistenceEntity.annualRevenue = domainEntity.annualRevenue;
    persistenceEntity.numberOfEmployees = domainEntity.numberOfEmployees;
    persistenceEntity.billingAddress = domainEntity.billingAddress;
    persistenceEntity.shippingAddress = domainEntity.shippingAddress;
    persistenceEntity.ownerId = domainEntity.ownerId;
    persistenceEntity.statusId = domainEntity.statusId;
    persistenceEntity.isArchived = domainEntity.isArchived;
    persistenceEntity.customFields = domainEntity.customFields;
    persistenceEntity.tags = domainEntity.tags;
    return persistenceEntity;
  }
}
