import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model, Types } from 'mongoose';
import {
  TenantSchemaClass,
  TenantSchemaDocument,
} from '../entities/tenant.schema';
import { Tenant } from '../../../../domain/tenant';
import { TenantMapper } from '../mappers/tenant.mapper';

@Injectable()
export class TenantsRepository {
  constructor(
    @InjectModel(TenantSchemaClass.name)
    private readonly tenantsModel: Model<TenantSchemaDocument>,
  ) {}

  async create(
    data: Partial<Tenant>,
    session?: ClientSession,
  ): Promise<Tenant> {
    const [created] = await this.tenantsModel.create([data], { session });
    return TenantMapper.toDomain(created);
  }

  async findByAlias(alias: string): Promise<Tenant | null> {
    const doc = await this.tenantsModel.findOne({ alias }).exec();
    return doc ? TenantMapper.toDomain(doc) : null;
  }

  async findByKeycloakOrgId(keycloakOrgId: string): Promise<Tenant | null> {
    const doc = await this.tenantsModel.findOne({ keycloakOrgId }).exec();
    return doc ? TenantMapper.toDomain(doc) : null;
  }

  async findById(id: string): Promise<Tenant | null> {
    const doc = await this.tenantsModel.findById(id).exec();
    return doc ? TenantMapper.toDomain(doc) : null;
  }

  async updateOwner(
    tenantId: string,
    ownerId: string,
    session?: ClientSession,
  ): Promise<void> {
    await this.tenantsModel.updateOne(
      { _id: new Types.ObjectId(tenantId) },
      { $set: { owner: new Types.ObjectId(ownerId) } },
      { session },
    );
  }

  async update(
    id: string,
    payload: Partial<Omit<Tenant, 'id'>>,
    session?: ClientSession,
  ): Promise<Tenant | null> {
    const updated = await this.tenantsModel
      .findByIdAndUpdate(id, { $set: payload }, { new: true, session })
      .exec();
    return updated ? TenantMapper.toDomain(updated) : null;
  }
}
