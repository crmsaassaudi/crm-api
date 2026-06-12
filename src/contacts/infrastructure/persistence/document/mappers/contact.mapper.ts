import { Contact } from '../../../../domain/contact';
import { ContactSchemaClass } from '../entities/contact.schema';
import { UserMapper } from '../../../../../users/infrastructure/persistence/document/mappers/user.mapper';

export class ContactMapper {
  static toDomain(raw: ContactSchemaClass): Contact {
    const domainEntity = new Contact();
    domainEntity.id = raw._id.toString();
    domainEntity.tenantId = raw.tenantId?.toString();
    domainEntity.firstName = raw.firstName;
    domainEntity.lastName = raw.lastName;
    domainEntity.emails = raw.emails ?? [];
    domainEntity.phones = raw.phones ?? [];
    domainEntity.isConverted = raw.isConverted;
    domainEntity.lifecycleStageId = raw.lifecycleStageId?.toString();
    domainEntity.statusId = raw.statusId?.toString();
    domainEntity.companyName = raw.companyName;
    domainEntity.accountId = raw.accountId?.toString();
    domainEntity.title = raw.title;
    domainEntity.sourceId = raw.sourceId?.toString();
    domainEntity.role = raw.role;
    domainEntity.address = raw.address;
    domainEntity.birthday = raw.birthday;
    domainEntity.customFields = raw.customFields;
    domainEntity.score = raw.score;
    domainEntity.emailOptIn = raw.emailOptIn ?? false;
    domainEntity.smsOptIn = raw.smsOptIn ?? false;
    domainEntity.doNotCall = raw.doNotCall ?? false;
    domainEntity.tags = raw.tags ?? [];
    domainEntity.omniIdentities = (raw.omniIdentities || []).map((el: any) => {
      return {
        channelType: el.channelType,
        senderId: el.senderId?.toString(),
      };
    });
    domainEntity.isShadow = raw.isShadow;
    domainEntity.stageHistory = (raw.stageHistory || []).map((entry: any) => ({
      fromStage: entry.fromStage,
      toStage: entry.toStage,
      changedAt: entry.changedAt,
      changedById: entry.changedById?.toString(),
      reason: entry.reason,
      direction: entry.direction,
      skippedStages: entry.skippedStages ?? [],
    }));

    domainEntity.ownerId = raw.ownerId?.toString();
    domainEntity.createdById = raw.createdById?.toString();
    domainEntity.updatedById = raw.updatedById?.toString();

    if ((raw as any).owner) {
      domainEntity.owner = UserMapper.toDomain((raw as any).owner);
    }
    if ((raw as any).createdBy) {
      domainEntity.createdBy = UserMapper.toDomain((raw as any).createdBy);
    }
    if ((raw as any).updatedBy) {
      domainEntity.updatedBy = UserMapper.toDomain((raw as any).updatedBy);
    }
    domainEntity.createdAt = raw.createdAt;
    domainEntity.updatedAt = raw.updatedAt;
    domainEntity.lastActivityAt = raw.lastActivityAt || raw.updatedAt;
    domainEntity.deletedAt = raw.deletedAt;
    domainEntity.version = (raw as any).__v;
    return domainEntity;
  }

  static toPersistence(domainEntity: Contact): ContactSchemaClass {
    const persistenceEntity = new ContactSchemaClass();
    if (domainEntity.id) {
      persistenceEntity._id = domainEntity.id;
    }
    persistenceEntity.tenantId = domainEntity.tenantId;
    persistenceEntity.firstName = domainEntity.firstName;
    persistenceEntity.lastName = domainEntity.lastName;
    if (domainEntity.emails !== undefined) persistenceEntity.emails = domainEntity.emails;
    if (domainEntity.phones !== undefined) persistenceEntity.phones = domainEntity.phones;
    persistenceEntity.isConverted = domainEntity.isConverted;
    persistenceEntity.lifecycleStageId = domainEntity.lifecycleStageId;
    persistenceEntity.statusId = domainEntity.statusId;
    persistenceEntity.companyName = domainEntity.companyName;
    persistenceEntity.accountId = domainEntity.accountId;
    persistenceEntity.title = domainEntity.title;
    persistenceEntity.sourceId = domainEntity.sourceId;
    persistenceEntity.role = domainEntity.role;
    persistenceEntity.address = domainEntity.address;
    persistenceEntity.birthday = domainEntity.birthday;
    persistenceEntity.customFields = domainEntity.customFields;
    persistenceEntity.score = domainEntity.score;
    persistenceEntity.emailOptIn = domainEntity.emailOptIn;
    persistenceEntity.smsOptIn = domainEntity.smsOptIn;
    persistenceEntity.doNotCall = domainEntity.doNotCall;
    if (domainEntity.tags !== undefined) persistenceEntity.tags = domainEntity.tags;
    if (domainEntity.omniIdentities !== undefined) persistenceEntity.omniIdentities = domainEntity.omniIdentities;
    if (domainEntity.isShadow !== undefined) {
      persistenceEntity.isShadow = domainEntity.isShadow;
    }
    persistenceEntity.ownerId = domainEntity.ownerId;
    persistenceEntity.createdById = domainEntity.createdById;
    persistenceEntity.updatedById = domainEntity.updatedById;
    persistenceEntity.lastActivityAt = domainEntity.lastActivityAt;
    persistenceEntity.deletedAt = domainEntity.deletedAt;
    if (domainEntity.stageHistory !== undefined) persistenceEntity.stageHistory = domainEntity.stageHistory;
    if (domainEntity.version !== undefined) {
      (persistenceEntity as any).__v = domainEntity.version;
    }
    return persistenceEntity;
  }
}
