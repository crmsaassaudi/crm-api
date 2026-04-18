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
    domainEntity.lifecycleStage = raw.lifecycleStage;
    domainEntity.status = raw.status;
    domainEntity.companyName = raw.companyName;
    domainEntity.accountId = raw.accountId?.toString();
    domainEntity.title = raw.title;
    domainEntity.source = raw.source;
    domainEntity.score = raw.score;
    domainEntity.omniIdentities = (raw.omniIdentities || []).map((el: any) => {
      return {
        channelType: el.channelType,
        senderId: el.senderId?.toString(),
      };
    });
    domainEntity.isShadow = raw.isShadow;

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
    domainEntity.deletedAt = raw.deletedAt;
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
    persistenceEntity.emails = domainEntity.emails ?? [];
    persistenceEntity.phones = domainEntity.phones ?? [];
    persistenceEntity.isConverted = domainEntity.isConverted;
    persistenceEntity.lifecycleStage = domainEntity.lifecycleStage;
    persistenceEntity.status = domainEntity.status;
    persistenceEntity.companyName = domainEntity.companyName;
    persistenceEntity.accountId = domainEntity.accountId;
    persistenceEntity.title = domainEntity.title;
    persistenceEntity.source = domainEntity.source;
    persistenceEntity.score = domainEntity.score;
    persistenceEntity.omniIdentities = domainEntity.omniIdentities ?? [];
    if (domainEntity.isShadow !== undefined) {
      persistenceEntity.isShadow = domainEntity.isShadow;
    }
    persistenceEntity.ownerId = domainEntity.ownerId;
    persistenceEntity.createdById = domainEntity.createdById;
    persistenceEntity.updatedById = domainEntity.updatedById;
    return persistenceEntity;
  }
}
