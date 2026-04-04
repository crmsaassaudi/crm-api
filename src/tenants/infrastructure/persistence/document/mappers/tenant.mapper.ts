import { Types } from 'mongoose';
import {
  Tenant,
  SubscriptionPlan,
  TenantStatus,
} from '../../../../domain/tenant';
import { TenantSchemaClass } from '../entities/tenant.schema';

export class TenantMapper {
  static toDomain(raw: TenantSchemaClass): Tenant {
    const tenant = new Tenant();
    tenant.id = raw._id.toString();
    tenant.keycloakOrgId = raw.keycloakOrgId;
    tenant.alias = raw.alias;
    tenant.name = raw.name;
    tenant.ownerId = raw.ownerId ? raw.ownerId.toString() : null!;
    tenant.subscriptionPlan = raw.subscriptionPlan;
    tenant.status = raw.status;

    // Extract plain object to avoid Mongoose subdocument serialization issues
    tenant.omniSettings = raw.omniSettings
      ? { resolveNoteMode: raw.omniSettings.resolveNoteMode }
      : { resolveNoteMode: 'optional' };

    tenant.i18nSettings = raw.i18nSettings
      ? {
          locale: raw.i18nSettings.locale ?? 'en',
          timezone: raw.i18nSettings.timezone ?? 'UTC',
          dateFormat: raw.i18nSettings.dateFormat ?? 'MM/DD/YYYY',
          currency: raw.i18nSettings.currency ?? 'USD',
        }
      : {
          locale: 'en',
          timezone: 'UTC',
          dateFormat: 'MM/DD/YYYY',
          currency: 'USD',
        };

    tenant.createdAt = raw.createdAt;
    tenant.updatedAt = raw.updatedAt;
    return tenant;
  }

  static toPersistence(domain: Tenant): Partial<TenantSchemaClass> {
    const persistence: Partial<TenantSchemaClass> = {};

    if (domain.id) {
      (persistence as any)._id = new Types.ObjectId(domain.id);
    }

    persistence.keycloakOrgId = domain.keycloakOrgId;
    persistence.alias = domain.alias;
    persistence.name = domain.name;

    if (domain.ownerId) {
      persistence.ownerId = new Types.ObjectId(domain.ownerId) as any;
    }

    persistence.subscriptionPlan =
      domain.subscriptionPlan ?? SubscriptionPlan.FREE;
    persistence.status = domain.status ?? TenantStatus.ACTIVE;

    if (domain.i18nSettings) {
      persistence.i18nSettings = { ...domain.i18nSettings };
    }

    return persistence;
  }
}
