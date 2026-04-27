import { Deal } from '../../../../domain/deal';
import { DealSchemaClass } from '../entities/deal.schema';
import { UserMapper } from '../../../../../users/infrastructure/persistence/document/mappers/user.mapper';

export class DealMapper {
  static toDomain(raw: DealSchemaClass): Deal {
    const domainEntity = new Deal();
    domainEntity.id = raw._id.toString();
    domainEntity.tenantId = raw.tenantId?.toString();
    domainEntity.title = raw.title;
    domainEntity.name = raw.name;
    domainEntity.pipeline = raw.pipeline;
    domainEntity.stageId = raw.stageId?.toString();
    domainEntity.probability = raw.probability;
    domainEntity.value = raw.value;
    domainEntity.currency = raw.currency;
    domainEntity.accountId = raw.accountId?.toString();
    domainEntity.accountName = raw.accountName;
    domainEntity.contactIds = raw.contactIds?.map((c) => c.toString());

    if (raw.ownerId) {
      domainEntity.ownerId =
        typeof raw.ownerId === 'string'
          ? raw.ownerId
          : (raw.ownerId as any)._id?.toString();
    }
    if (raw.createdById) {
      domainEntity.createdById =
        typeof raw.createdById === 'string'
          ? raw.createdById
          : (raw.createdById as any)._id?.toString();
    }
    if (raw.updatedById) {
      domainEntity.updatedById =
        typeof raw.updatedById === 'string'
          ? raw.updatedById
          : (raw.updatedById as any)._id?.toString();
    }

    domainEntity.description = raw.description;
    domainEntity.sourceId = raw.sourceId?.toString();

    // Populate owner User object from virtual
    if ((raw as any).owner) {
      domainEntity.owner = UserMapper.toDomain((raw as any).owner);
    }
    if ((raw as any).dealStage) {
      const s = (raw as any).dealStage;
      domainEntity.dealStage = {
        id: s._id?.toString(),
        label: s.label,
        apiName: s.apiName,
        color: s.color,
        probability: s.probability,
        isWon: s.isWon,
        isLost: s.isLost,
      };
    }
    if ((raw as any).dealSource) {
      const s = (raw as any).dealSource;
      domainEntity.dealSource = { id: s._id?.toString(), name: s.name };
    }

    domainEntity.lostReason = raw.lostReason;
    domainEntity.tags = raw.tags;
    domainEntity.customFields = raw.customFields;
    domainEntity.closeDate = raw.closeDate;
    domainEntity.wonAt = raw.wonAt;
    domainEntity.lostAt = raw.lostAt;
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
    persistenceEntity.tenantId = domainEntity.tenantId;
    persistenceEntity.title = domainEntity.title;
    persistenceEntity.name = domainEntity.name;
    persistenceEntity.pipeline = domainEntity.pipeline;
    persistenceEntity.stageId = domainEntity.stageId;
    persistenceEntity.probability = domainEntity.probability;
    persistenceEntity.value = domainEntity.value;
    persistenceEntity.currency = domainEntity.currency;
    persistenceEntity.accountId = domainEntity.accountId;
    persistenceEntity.accountName = domainEntity.accountName;
    persistenceEntity.contactIds = domainEntity.contactIds;
    persistenceEntity.ownerId = domainEntity.ownerId;
    persistenceEntity.description = domainEntity.description;
    persistenceEntity.sourceId = domainEntity.sourceId;
    persistenceEntity.lostReason = domainEntity.lostReason;
    persistenceEntity.tags = domainEntity.tags;
    persistenceEntity.customFields = domainEntity.customFields;
    persistenceEntity.closeDate = domainEntity.closeDate;
    persistenceEntity.wonAt = domainEntity.wonAt;
    persistenceEntity.lostAt = domainEntity.lostAt;
    if (domainEntity.createdById)
      persistenceEntity.createdById = domainEntity.createdById;
    if (domainEntity.updatedById)
      persistenceEntity.updatedById = domainEntity.updatedById;
    return persistenceEntity;
  }
}
