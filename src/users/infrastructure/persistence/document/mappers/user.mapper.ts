import { User } from '../../../../domain/user';
import { UserSchemaClass } from '../entities/user.schema';
import { FileSchemaClass } from '../../../../../files/infrastructure/persistence/document/entities/file.schema';
import { FileMapper } from '../../../../../files/infrastructure/persistence/document/mappers/file.mapper';
import { Role } from '../../../../../roles/domain/role';
import { Status } from '../../../../../statuses/domain/status';
import { PlatformRoleEnum } from '../../../../../roles/platform-role.enum';
import { StatusEnum } from '../../../../../statuses/statuses.enum';

export class UserMapper {
  static toDomain(raw: UserSchemaClass): User {
    const domainEntity = new User();
    domainEntity.id = raw._id.toString();
    domainEntity.version = raw.__v;
    domainEntity.tenants = raw.tenants
      ? raw.tenants.map((t) => ({
          tenantId:
            (t as any).tenantId?.toString() ||
            (t as any).tenant?.toString() ||
            '',
          roles: t.roles,
          permissions: (t as any).permissions || [],
          permissionOverrides: (t as any).permissionOverrides || {},
          joinedAt: t.joinedAt,
        }))
      : [];
    domainEntity.email = raw.email;
    domainEntity.password = raw.password;
    domainEntity.provider = raw.provider;
    domainEntity.keycloakId = raw.keycloakId;
    domainEntity.firstName = raw.firstName;
    domainEntity.lastName = raw.lastName;

    if (raw.photo) {
      domainEntity.photo = FileMapper.toDomain(raw.photo);
    } else if (raw.photo === null) {
      domainEntity.photo = null;
    }

    // platformRole is a flat string (PlatformRoleEnum value)
    if (raw.platformRole) {
      domainEntity.platformRole = new Role();
      domainEntity.platformRole.id = raw.platformRole as PlatformRoleEnum;
      domainEntity.platformRole.name = raw.platformRole;
    }

    // status is a flat string (StatusEnum value)
    if (raw.status) {
      domainEntity.status = new Status();
      domainEntity.status.id = raw.status as StatusEnum;
      domainEntity.status.name = raw.status;
    }

    domainEntity.omniMaxCapacity = raw.omniMaxCapacity ?? null;
    domainEntity.skills = raw.skills ?? [];
    domainEntity.i18nPreferences = raw.i18nPreferences
      ? {
          locale: raw.i18nPreferences.locale ?? null,
          timezone: raw.i18nPreferences.timezone ?? null,
        }
      : null;
    domainEntity.reportsToId = raw.reportsToId?.toString() ?? null;
    domainEntity.createdAt = raw.createdAt;
    domainEntity.updatedAt = raw.updatedAt;
    domainEntity.deletedAt = raw.deletedAt;

    return domainEntity;
  }

  static toPersistence(domainEntity: User): UserSchemaClass {
    let photo: FileSchemaClass | undefined = undefined;

    if (domainEntity.photo) {
      photo = new FileSchemaClass();
      photo._id = domainEntity.photo.id;
      photo.path = domainEntity.photo.path;
    }

    const persistenceSchema = new UserSchemaClass();
    if (domainEntity.id && typeof domainEntity.id === 'string') {
      persistenceSchema._id = domainEntity.id;
    }

    persistenceSchema.tenants = domainEntity.tenants
      ? domainEntity.tenants.map((t) => ({
          tenantId: t.tenantId as any,
          roles: t.roles,
          permissions: t.permissions || [],
          permissionOverrides: t.permissionOverrides || {},
          joinedAt: t.joinedAt,
        }))
      : [];

    if (domainEntity.version !== undefined) {
      persistenceSchema.__v = domainEntity.version;
    }

    persistenceSchema.email = domainEntity.email;
    persistenceSchema.password = domainEntity.password;
    persistenceSchema.provider = domainEntity.provider;
    persistenceSchema.keycloakId = domainEntity.keycloakId;
    persistenceSchema.firstName = domainEntity.firstName;
    persistenceSchema.lastName = domainEntity.lastName;
    persistenceSchema.photo = photo;

    // platformRole and status are flat strings
    persistenceSchema.platformRole = domainEntity.platformRole?.id ?? null;
    persistenceSchema.status = domainEntity.status?.id ?? null;

    if (domainEntity.omniMaxCapacity !== undefined) {
      persistenceSchema.omniMaxCapacity = domainEntity.omniMaxCapacity;
    }
    if (domainEntity.skills !== undefined) {
      persistenceSchema.skills = domainEntity.skills;
    }
    if (domainEntity.i18nPreferences !== undefined) {
      persistenceSchema.i18nPreferences = domainEntity.i18nPreferences;
    }
    if (domainEntity.reportsToId !== undefined) {
      persistenceSchema.reportsToId = domainEntity.reportsToId;
    }
    persistenceSchema.createdAt = domainEntity.createdAt;
    persistenceSchema.updatedAt = domainEntity.updatedAt;
    persistenceSchema.deletedAt = domainEntity.deletedAt;

    return persistenceSchema;
  }
}
