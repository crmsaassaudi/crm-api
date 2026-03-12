import { Contact } from '../../../../domain/contact';
import { ContactSchemaClass } from '../entities/contact.schema';
import { UserMapper } from '../../../../../users/infrastructure/persistence/document/mappers/user.mapper';

export class ContactMapper {
  static toDomain(raw: ContactSchemaClass): Contact {
    const domainEntity = new Contact();
    domainEntity.id = raw._id.toString();
    domainEntity.tenant = raw.tenant;
    domainEntity.firstName = raw.firstName;
    domainEntity.lastName = raw.lastName;
    domainEntity.emails = raw.emails ?? [];
    domainEntity.phones = raw.phones ?? [];
    domainEntity.isConverted = raw.isConverted;
    domainEntity.lifecycleStage = raw.lifecycleStage;
    domainEntity.status = raw.status;
    domainEntity.companyName = raw.companyName;
    domainEntity.account = raw.account?.toString();
    domainEntity.title = raw.title;
    domainEntity.source = raw.source;
    domainEntity.score = raw.score;

    if (raw.owner) {
      domainEntity.owner =
        typeof raw.owner === 'string'
          ? raw.owner
          : UserMapper.toDomain(raw.owner as any);
    }
    if (raw.createdBy) {
      domainEntity.createdBy =
        typeof raw.createdBy === 'string'
          ? raw.createdBy
          : UserMapper.toDomain(raw.createdBy as any);
    }
    if (raw.updatedBy) {
      domainEntity.updatedBy =
        typeof raw.updatedBy === 'string'
          ? raw.updatedBy
          : UserMapper.toDomain(raw.updatedBy as any);
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
    persistenceEntity.tenant = domainEntity.tenant;
    persistenceEntity.firstName = domainEntity.firstName;
    persistenceEntity.lastName = domainEntity.lastName;
    persistenceEntity.emails = domainEntity.emails ?? [];
    persistenceEntity.phones = domainEntity.phones ?? [];
    persistenceEntity.isConverted = domainEntity.isConverted;
    persistenceEntity.lifecycleStage = domainEntity.lifecycleStage;
    persistenceEntity.status = domainEntity.status;
    persistenceEntity.companyName = domainEntity.companyName;
    persistenceEntity.account = domainEntity.account;
    persistenceEntity.title = domainEntity.title;
    persistenceEntity.source = domainEntity.source;
    persistenceEntity.score = domainEntity.score;
    persistenceEntity.owner = (
      typeof domainEntity.owner === 'string'
        ? domainEntity.owner
        : domainEntity.owner?.id
    ) as string | undefined;
    persistenceEntity.createdBy = (
      typeof domainEntity.createdBy === 'string'
        ? domainEntity.createdBy
        : domainEntity.createdBy?.id
    ) as string;
    persistenceEntity.updatedBy = (
      typeof domainEntity.updatedBy === 'string'
        ? domainEntity.updatedBy
        : domainEntity.updatedBy?.id
    ) as string;
    return persistenceEntity;
  }
}
