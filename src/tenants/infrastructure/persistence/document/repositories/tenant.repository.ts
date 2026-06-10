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

  async findByIds(ids: string[]): Promise<Tenant[]> {
    if (!ids.length) {
      return [];
    }

    const docs = await this.tenantsModel.find({ _id: { $in: ids } }).exec();
    return docs.map((doc) => TenantMapper.toDomain(doc));
  }

  async findByOwnerId(ownerId: string): Promise<Tenant[]> {
    const docs = await this.tenantsModel
      .find({ ownerId: new Types.ObjectId(ownerId) })
      .exec();
    return docs.map((doc) => TenantMapper.toDomain(doc));
  }

  async updateOwner(
    tenantId: string,
    ownerId: string,
    session?: ClientSession,
  ): Promise<void> {
    await this.tenantsModel.updateOne(
      { _id: new Types.ObjectId(tenantId) },
      { $set: { ownerId: new Types.ObjectId(ownerId) } },
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

  async updateOmniSettings(
    tenantId: string,
    omniSettings: { resolveNoteMode: 'disabled' | 'optional' | 'required' },
  ): Promise<Tenant | null> {
    const updated = await this.tenantsModel
      .findByIdAndUpdate(tenantId, { $set: { omniSettings } }, { new: true })
      .exec();
    return updated ? TenantMapper.toDomain(updated) : null;
  }

  /**
   * Atomically increment storage usage WITH quota guard.
   * Returns true if increment succeeded (within quota), false if over quota.
   * Uses $expr + $lte to ensure usedBytes + increment <= limitBytes.
   */
  async atomicIncrementStorage(
    tenantId: string,
    bytes: number,
  ): Promise<boolean> {
    const result = await this.tenantsModel.updateOne(
      {
        _id: tenantId,
        $or: [
          { 'storageQuota.limitBytes': -1 }, // unlimited
          {
            $expr: {
              $lte: [
                { $add: ['$storageQuota.usedBytes', bytes] },
                '$storageQuota.limitBytes',
              ],
            },
          },
        ],
      },
      { $inc: { 'storageQuota.usedBytes': bytes } },
    );
    return result.modifiedCount > 0;
  }

  /**
   * Atomically decrement storage usage (for rollback / hard-delete).
   */
  async atomicDecrementStorage(
    tenantId: string,
    bytes: number,
  ): Promise<void> {
    await this.tenantsModel.updateOne(
      { _id: tenantId },
      { $inc: { 'storageQuota.usedBytes': -bytes } },
    );
  }

  /**
   * Update the tenant's storage quota limit (SUPER_ADMIN operation).
   */
  async updateStorageQuota(
    tenantId: string,
    limitBytes: number,
    warnThresholdPercent?: number,
  ): Promise<Tenant | null> {
    const setFields: Record<string, unknown> = {
      'storageQuota.limitBytes': limitBytes,
    };
    if (warnThresholdPercent !== undefined) {
      setFields['storageQuota.warnThresholdPercent'] = warnThresholdPercent;
    }
    const updated = await this.tenantsModel
      .findByIdAndUpdate(tenantId, { $set: setFields }, { new: true })
      .exec();
    return updated ? TenantMapper.toDomain(updated) : null;
  }

  /**
   * Recalculate usedBytes + update storageBreakdown (daily cron).
   */
  async reconcileStorageUsage(
    tenantId: string,
    usedBytes: number,
    breakdown: {
      omni_media: { count: number; sizeBytes: number };
      ticket_attachment: { count: number; sizeBytes: number };
      general: { count: number; sizeBytes: number };
    },
  ): Promise<void> {
    await this.tenantsModel.updateOne(
      { _id: tenantId },
      {
        $set: {
          'storageQuota.usedBytes': usedBytes,
          'storageQuota.lastRecalculatedAt': new Date(),
          storageBreakdown: {
            ...breakdown,
            lastCalculatedAt: new Date(),
          },
        },
      },
    );
  }

  /**
   * Update the tenant's i18n settings (locale, timezone, dateFormat, currency).
   */
  async updateI18nSettings(
    tenantId: string,
    settings: Partial<{
      locale: string;
      timezone: string;
      dateFormat: string;
      currency: string;
    }>,
  ): Promise<Tenant | null> {
    const setFields: Record<string, string> = {};
    if (settings.locale !== undefined)
      setFields['i18nSettings.locale'] = settings.locale;
    if (settings.timezone !== undefined)
      setFields['i18nSettings.timezone'] = settings.timezone;
    if (settings.dateFormat !== undefined)
      setFields['i18nSettings.dateFormat'] = settings.dateFormat;
    if (settings.currency !== undefined)
      setFields['i18nSettings.currency'] = settings.currency;

    if (Object.keys(setFields).length === 0) {
      return this.findById(tenantId);
    }

    const updated = await this.tenantsModel
      .findByIdAndUpdate(tenantId, { $set: setFields }, { new: true })
      .exec();
    return updated ? TenantMapper.toDomain(updated) : null;
  }

  /**
   * Grant one or more feature permission keys to a tenant.
   * Uses $addToSet to avoid duplicates. Idempotent.
   */
  async grantFeaturePermissions(
    tenantId: string,
    permissions: string[],
  ): Promise<Tenant | null> {
    const updated = await this.tenantsModel
      .findByIdAndUpdate(
        tenantId,
        { $addToSet: { availablePermissions: { $each: permissions } } },
        { new: true },
      )
      .exec();
    return updated ? TenantMapper.toDomain(updated) : null;
  }

  /**
   * Revoke one or more feature permission keys from a tenant.
   * Uses $pull to remove. Idempotent.
   */
  async revokeFeaturePermissions(
    tenantId: string,
    permissions: string[],
  ): Promise<Tenant | null> {
    const updated = await this.tenantsModel
      .findByIdAndUpdate(
        tenantId,
        { $pull: { availablePermissions: { $in: permissions } } },
        { new: true },
      )
      .exec();
    return updated ? TenantMapper.toDomain(updated) : null;
  }

  /**
   * Replace the entire availablePermissions array for a tenant.
   * Pass null to reset to Core-only baseline.
   */
  async setAvailablePermissions(
    tenantId: string,
    permissions: string[] | null,
  ): Promise<Tenant | null> {
    const updated = await this.tenantsModel
      .findByIdAndUpdate(
        tenantId,
        { $set: { availablePermissions: permissions } },
        { new: true },
      )
      .exec();
    return updated ? TenantMapper.toDomain(updated) : null;
  }
}
