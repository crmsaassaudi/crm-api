import { Deal } from '../../../../domain/deal';
import { DealSchemaClass } from '../entities/deal.schema';

export class DealMapper {
    static toDomain(raw: DealSchemaClass): Deal {
        const domainEntity = new Deal();
        domainEntity.id = raw._id.toString();
        domainEntity.tenant = raw.tenant;
        domainEntity.name = raw.name;
        domainEntity.amount = raw.amount;
        domainEntity.contact = raw.contact.toString();
        domainEntity.account = raw.account?.toString();
        domainEntity.stage = raw.stage;
        domainEntity.pipeline = raw.pipeline;
        domainEntity.closingDate = raw.closingDate;
        domainEntity.owner = raw.owner?.toString();
        domainEntity.createdAt = raw.createdAt;
        domainEntity.updatedAt = raw.updatedAt;
        domainEntity.deletedAt = raw.deletedAt;
        return domainEntity;
    }

    static toPersistence(domainEntity: Deal): DealSchemaClass {
        const persistenceEntity = new DealSchemaClass();
        if (domainEntity.id) {
            persistenceEntity._id = domainEntity.id;
        }
        persistenceEntity.tenant = domainEntity.tenant;
        persistenceEntity.name = domainEntity.name;
        persistenceEntity.amount = domainEntity.amount;
        persistenceEntity.contact = domainEntity.contact;
        persistenceEntity.account = domainEntity.account;
        persistenceEntity.stage = domainEntity.stage;
        persistenceEntity.pipeline = domainEntity.pipeline;
        persistenceEntity.closingDate = domainEntity.closingDate;
        persistenceEntity.owner = domainEntity.owner;
        return persistenceEntity;
    }
}
