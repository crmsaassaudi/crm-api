import { Account } from '../../../../domain/account';
import { AccountSchemaClass } from '../entities/account.schema';

export class AccountMapper {
    static toDomain(raw: AccountSchemaClass): Account {
        const domainEntity = new Account();
        domainEntity.id = raw._id.toString();
        domainEntity.tenant = raw.tenant;
        domainEntity.name = raw.name;
        domainEntity.website = raw.website;
        domainEntity.industry = raw.industry;
        domainEntity.type = raw.type;
        domainEntity.owner = raw.owner?.toString();
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
        persistenceEntity.owner = domainEntity.owner;
        return persistenceEntity;
    }
}
