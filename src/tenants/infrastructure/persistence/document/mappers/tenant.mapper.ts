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
    tenant.owner = raw.owner ? raw.owner.toString() : null!;
    tenant.subscriptionPlan = raw.subscriptionPlan;
    tenant.status = raw.status;
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

    if (domain.owner) {
      persistence.owner = new Types.ObjectId(domain.owner) as any;
    }

    persistence.subscriptionPlan =
      domain.subscriptionPlan ?? SubscriptionPlan.FREE;
    persistence.status = domain.status ?? TenantStatus.ACTIVE;

    return persistence;
  }
}
