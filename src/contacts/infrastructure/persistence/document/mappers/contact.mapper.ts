import { Contact } from '../../../../domain/contact';
import { ContactSchemaClass } from '../entities/contact.schema';
import { UserMapper } from '../../../../../users/infrastructure/persistence/document/mappers/user.mapper';

export class ContactMapper {
  static toDomain(raw: ContactSchemaClass): Contact {
    const domainEntity = new Contact();
    domainEntity.id = raw._id.toString();
    domainEntity.tenantId = raw.tenantId;
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
    domainEntity.omniSenderId = raw.omniSenderId;
    domainEntity.isShadow = raw.isShadow;

    if (raw.ownerId) {
      domainEntity.ownerId =
        typeof raw.ownerId === 'string'
          ? raw.ownerId
          : (raw.ownerId as any)._id?.toString();
    }
    if ((raw as any).owner) {
      domainEntity.owner = UserMapper.toDomain((raw as any).owner as any);
    }
    if (raw.createdById) {
      domainEntity.createdById =
        typeof raw.createdById === 'string'
          ? raw.createdById
          : (raw.createdById as any)._id?.toString();
    }
    if ((raw as any).createdBy) {
      domainEntity.createdBy = UserMapper.toDomain(
        (raw as any).createdBy as any,
      );
    }
    if (raw.updatedById) {
      domainEntity.updatedById =
        typeof raw.updatedById === 'string'
          ? raw.updatedById
          : (raw.updatedById as any)._id?.toString();
    }
    if ((raw as any).updatedBy) {
      domainEntity.updatedBy = UserMapper.toDomain(
        (raw as any).updatedBy as any,
      );
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
    persistenceEntity.omniSenderId = domainEntity.omniSenderId;
    if (domainEntity.isShadow !== undefined) {
      persistenceEntity.isShadow = domainEntity.isShadow;
    }
    persistenceEntity.ownerId = domainEntity.ownerId;
    persistenceEntity.createdById = domainEntity.createdById;
    persistenceEntity.updatedById = domainEntity.updatedById;
    return persistenceEntity;
  }
}
