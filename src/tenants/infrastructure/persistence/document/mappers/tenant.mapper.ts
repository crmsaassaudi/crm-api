import { Tenant } from '../../../../domain/tenant';
import { TenantSchemaClass } from '../entities/tenant.schema';

export class TenantMapper {
    static toDomain(raw: TenantSchemaClass): Tenant {
        const tenant = new Tenant();
        tenant.id = raw._id.toString();
        tenant.name = raw.name;
        tenant.domain = raw.domain;
        tenant.owner = raw.owner;
        tenant.createdAt = raw.createdAt;
        tenant.updatedAt = raw.updatedAt;
        tenant.deletedAt = raw.deletedAt;
        return tenant;
    }

    static toPersistence(domainEntity: Tenant): TenantSchemaClass {
        const tenantSchema = new TenantSchemaClass();
        if (domainEntity.id) {
            tenantSchema._id = domainEntity.id;
        }
        tenantSchema.name = domainEntity.name;
        tenantSchema.domain = domainEntity.domain;
        tenantSchema.owner = domainEntity.owner;
        tenantSchema.createdAt = domainEntity.createdAt;
        tenantSchema.updatedAt = domainEntity.updatedAt;
        tenantSchema.deletedAt = domainEntity.deletedAt;
        return tenantSchema;
    }
}
