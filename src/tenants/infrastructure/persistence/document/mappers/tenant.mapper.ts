import { Types } from 'mongoose';
import {
  Tenant,
  SubscriptionPlan,
  TenantStatus,
  ProvisioningStatus,
} from '../../../../domain/tenant';
import { TenantSchemaClass } from '../entities/tenant.schema';

export class TenantMapper {
  static toDomain(raw: TenantSchemaClass): Tenant {
    const tenant = new Tenant();
    tenant.id = raw._id.toString();
    tenant.keycloakOrgId = raw.keycloakOrgId;
    tenant.alias = raw.alias;
    tenant.name = raw.name;
    tenant.logoUrl = raw.logoUrl || '';
    tenant.ownerId = raw.ownerId ? raw.ownerId.toString() : null!;
    tenant.subscriptionPlan = raw.subscriptionPlan;
    tenant.status = raw.status;
    tenant.provisioningStatus =
      raw.provisioningStatus ?? ProvisioningStatus.READY;
    tenant.provisioningError = raw.provisioningError ?? undefined;
    tenant.onboardingGoal = raw.onboardingGoal ?? undefined;
    tenant.botWorkspaceId = raw.botWorkspaceId ?? undefined;

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

    // null = Core only (default); array = Core + granted features
    tenant.availablePermissions = raw.availablePermissions ?? null;
    tenant.disabledCorePermissions = raw.disabledCorePermissions ?? [];

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
    if (domain.logoUrl !== undefined) {
      persistence.logoUrl = domain.logoUrl;
    }

    if (domain.ownerId) {
      persistence.ownerId = new Types.ObjectId(domain.ownerId) as any;
    }

    persistence.subscriptionPlan =
      domain.subscriptionPlan ?? SubscriptionPlan.FREE;
    persistence.status = domain.status ?? TenantStatus.ACTIVE;
    persistence.provisioningStatus =
      domain.provisioningStatus ?? ProvisioningStatus.READY;
    if (domain.provisioningError !== undefined) {
      persistence.provisioningError = domain.provisioningError;
    }
    if (domain.onboardingGoal !== undefined) {
      persistence.onboardingGoal = domain.onboardingGoal;
    }
    if (domain.botWorkspaceId !== undefined) {
      persistence.botWorkspaceId = domain.botWorkspaceId;
    }

    if (domain.i18nSettings) {
      persistence.i18nSettings = { ...domain.i18nSettings };
    }

    // Persist null explicitly to keep the "Core only" semantic in DB
    if (domain.availablePermissions !== undefined) {
      persistence.availablePermissions = domain.availablePermissions;
    }

    if (domain.disabledCorePermissions !== undefined) {
      persistence.disabledCorePermissions = domain.disabledCorePermissions;
    }

    return persistence;
  }
}
