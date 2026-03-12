import { Account } from '../../../../domain/account';
import { AccountSchemaClass } from '../entities/account.schema';
import { UserMapper } from '../../../../../users/infrastructure/persistence/document/mappers/user.mapper';

export class AccountMapper {
  static toDomain(raw: AccountSchemaClass): Account {
    const domainEntity = new Account();
    domainEntity.id = raw._id.toString();
    domainEntity.tenant = raw.tenant;
    domainEntity.name = raw.name;
    domainEntity.website = raw.website;
    domainEntity.industry = raw.industry;
    domainEntity.type = raw.type;
    domainEntity.emails = raw.emails ?? [];
    domainEntity.phones = raw.phones ?? [];
    domainEntity.taxId = raw.taxId;
    domainEntity.annualRevenue = raw.annualRevenue;
    domainEntity.numberOfEmployees = raw.numberOfEmployees;
    domainEntity.billingAddress = raw.billingAddress;
    domainEntity.shippingAddress = raw.shippingAddress;
    if (raw.owner) {
      domainEntity.owner =
        typeof raw.owner === 'string'
          ? raw.owner
          : UserMapper.toDomain(raw.owner as any);
    }
    domainEntity.status = raw.status;
    domainEntity.isArchived = raw.isArchived;
    domainEntity.customFields = raw.customFields;
    domainEntity.tags = raw.tags;
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
    persistenceEntity.tenant = domainEntity.tenant;
    persistenceEntity.name = domainEntity.name;
    persistenceEntity.website = domainEntity.website;
    persistenceEntity.industry = domainEntity.industry;
    persistenceEntity.type = domainEntity.type;
    persistenceEntity.emails = domainEntity.emails ?? [];
    persistenceEntity.phones = domainEntity.phones ?? [];
    persistenceEntity.taxId = domainEntity.taxId;
    persistenceEntity.annualRevenue = domainEntity.annualRevenue;
    persistenceEntity.numberOfEmployees = domainEntity.numberOfEmployees;
    persistenceEntity.billingAddress = domainEntity.billingAddress;
    persistenceEntity.shippingAddress = domainEntity.shippingAddress;
    persistenceEntity.owner = (
      typeof domainEntity.owner === 'object'
        ? (domainEntity.owner as any).id
        : domainEntity.owner
    ) as string | undefined;
    persistenceEntity.status = domainEntity.status;
    persistenceEntity.isArchived = domainEntity.isArchived;
    persistenceEntity.customFields = domainEntity.customFields;
    persistenceEntity.tags = domainEntity.tags;
    return persistenceEntity;
  }
}
