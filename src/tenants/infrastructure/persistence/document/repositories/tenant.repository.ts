import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { TenantSchemaClass, TenantSchemaDocument } from '../entities/tenant.schema';
import { Tenant } from '../../../../domain/tenant';
import { TenantMapper } from '../mappers/tenant.mapper';

@Injectable()
export class TenantsRepository {
    constructor(
        @InjectModel(TenantSchemaClass.name)
        private readonly tenantsModel: Model<TenantSchemaDocument>,
    ) { }

    async create(data: Tenant): Promise<Tenant> {
        const persistenceModel = TenantMapper.toPersistence(data);
        const createdTenant = new this.tenantsModel(persistenceModel);
        const tenantObject = await createdTenant.save();
        return TenantMapper.toDomain(tenantObject);
    }

    async findByDomain(domain: string): Promise<Tenant | null> {
        const tenantObject = await this.tenantsModel.findOne({ domain });
        return tenantObject ? TenantMapper.toDomain(tenantObject) : null;
    }

    async findById(id: string): Promise<Tenant | null> {
        const tenantObject = await this.tenantsModel.findById(id);
        return tenantObject ? TenantMapper.toDomain(tenantObject) : null;
    }

    async update(id: string, payload: Partial<Tenant>): Promise<Tenant | null> {
        const updatedTenant = await this.tenantsModel.findByIdAndUpdate(
            id,
            payload,
            { new: true }
        );
        return updatedTenant ? TenantMapper.toDomain(updatedTenant) : null;
    }
}
