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

    tenant.omniSettings = this.mapOmniSettings(raw.omniSettings);
    tenant.i18nSettings = this.mapI18nSettings(raw.i18nSettings);

    // null = Core only (default); array = Core + granted features
    tenant.availablePermissions = raw.availablePermissions ?? null;
    tenant.disabledCorePermissions = raw.disabledCorePermissions ?? [];

    tenant.storageQuota = this.mapStorageQuota(raw.storageQuota);
    tenant.storageBreakdown = (raw as any).storageBreakdown ?? undefined;

    tenant.createdAt = raw.createdAt;
    tenant.updatedAt = raw.updatedAt;
    return tenant;
  }

  private static mapOmniSettings(rawSettings: any) {
    const defaultNs = { enabled: true, soundUrl: null, volume: 80 };
    if (!rawSettings) {
      return {
        resolveNoteMode: 'optional',
        notificationSound: {
          agent: { ...defaultNs },
          visitor: { ...defaultNs },
        },
      };
    }

    const rawNs = rawSettings.notificationSound;
    return {
      resolveNoteMode: rawSettings.resolveNoteMode,
      notificationSound: {
        agent: rawNs?.agent
          ? {
              enabled: rawNs.agent.enabled ?? true,
              soundUrl: rawNs.agent.soundUrl ?? null,
              volume: rawNs.agent.volume ?? 80,
            }
          : { ...defaultNs },
        visitor: rawNs?.visitor
          ? {
              enabled: rawNs.visitor.enabled ?? true,
              soundUrl: rawNs.visitor.soundUrl ?? null,
              volume: rawNs.visitor.volume ?? 80,
            }
          : { ...defaultNs },
      },
    };
  }

  private static mapI18nSettings(rawI18n: any) {
    if (!rawI18n) {
      return {
        locale: 'en',
        timezone: 'UTC',
        dateFormat: 'MM/DD/YYYY',
        currency: 'USD',
      };
    }
    return {
      locale: rawI18n.locale ?? 'en',
      timezone: rawI18n.timezone ?? 'UTC',
      dateFormat: rawI18n.dateFormat ?? 'MM/DD/YYYY',
      currency: rawI18n.currency ?? 'USD',
    };
  }

  private static mapStorageQuota(rawQuota: any) {
    if (!rawQuota) {
      return { limitBytes: 1073741824, usedBytes: 0, warnThresholdPercent: 80 };
    }
    return {
      limitBytes:
        rawQuota.limitBytes ??
        (rawQuota.limitMB != null
          ? rawQuota.limitMB * 1024 * 1024
          : 1073741824),
      usedBytes:
        rawQuota.usedBytes ??
        (rawQuota.usedMB != null
          ? Math.round(rawQuota.usedMB * 1024 * 1024)
          : 0),
      warnThresholdPercent: rawQuota.warnThresholdPercent ?? 80,
      lastRecalculatedAt: rawQuota.lastRecalculatedAt,
    };
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
