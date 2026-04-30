import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  ChannelConfigSchemaClass,
  ChannelConfigSchemaDocument,
} from '../entities/channel-config.schema';
import { ChannelConfig } from '../../../../domain/channel-config';

@Injectable()
export class ChannelConfigRepository {
  constructor(
    @InjectModel(ChannelConfigSchemaClass.name)
    private readonly model: Model<ChannelConfigSchemaDocument>,
  ) {}

  /**
   * List all non-deleted configs for a tenant.
   * Credentials are NOT included (select: false on schema).
   */
  async findAllByTenant(tenantId: string): Promise<ChannelConfig[]> {
    const docs = await this.model
      .find({ tenantId, deletedAt: null })
      .sort({ providerType: 1, name: 1 })
      .exec();
    return docs.map((d) => this.toDomain(d));
  }

  /**
   * Find by ID excluding credentials. For API responses.
   */
  async findById(tenantId: string, id: string): Promise<ChannelConfig | null> {
    const doc = await this.model
      .findOne({ _id: id, tenantId, deletedAt: null })
      .exec();
    return doc ? this.toDomain(doc) : null;
  }

  /**
   * Find by ID WITH encrypted credentials. Internal use only.
   */
  async findByIdWithCredentials(
    tenantId: string,
    id: string,
  ): Promise<ChannelConfig | null> {
    const doc = await this.model
      .findOne({ _id: id, tenantId, deletedAt: null })
      .select('+encryptedCredentials')
      .exec();
    return doc ? this.toDomain(doc) : null;
  }

  /**
   * Find by ID WITH credentials, skipping tenant filter.
   * Used by automation executors running in queue context (no CLS tenant).
   */
  async findByIdWithCredentialsNoTenant(
    id: string,
  ): Promise<ChannelConfig | null> {
    const doc = await this.model
      .findOne({ _id: id, deletedAt: null })
      .select('+encryptedCredentials')
      .setOptions({ skipTenantFilter: true } as any)
      .exec();
    return doc ? this.toDomain(doc) : null;
  }

  async create(data: Partial<ChannelConfig>): Promise<ChannelConfig> {
    const doc = await this.model.create(data);
    return this.toDomain(doc);
  }

  async update(
    tenantId: string,
    id: string,
    data: Partial<ChannelConfig>,
  ): Promise<ChannelConfig | null> {
    const doc = await this.model
      .findOneAndUpdate(
        { _id: id, tenantId, deletedAt: null },
        { $set: data },
        { new: true },
      )
      .exec();
    return doc ? this.toDomain(doc) : null;
  }

  /**
   * Soft-delete: set deletedAt timestamp.
   */
  async softDelete(tenantId: string, id: string): Promise<boolean> {
    const result = await this.model
      .findOneAndUpdate(
        { _id: id, tenantId, deletedAt: null },
        { $set: { deletedAt: new Date() } },
        { new: true },
      )
      .exec();
    return !!result;
  }

  /**
   * Atomic set-default: unset all others of same providerType, then set this one.
   */
  async setDefault(
    tenantId: string,
    id: string,
    providerType: string,
  ): Promise<void> {
    // Unset all defaults for this provider type
    await this.model
      .updateMany(
        { tenantId, providerType, deletedAt: null },
        { $set: { isDefault: false } },
      )
      .exec();

    // Set this config as default
    await this.model
      .findOneAndUpdate(
        { _id: id, tenantId, deletedAt: null },
        { $set: { isDefault: true } },
      )
      .exec();
  }

  // ── Health Check Methods (Phase 2) ──────────────────────────────────────

  /**
   * Find all non-deleted, non-disabled configs across ALL tenants.
   * Used by the Background Health Check cronjob (no CLS tenant context).
   * Includes encrypted credentials for re-verification.
   */
  async findAllActiveForHealthCheck(): Promise<ChannelConfig[]> {
    const docs = await this.model
      .find({
        deletedAt: null,
        status: { $ne: 'disabled' },
      })
      .select('+encryptedCredentials')
      .setOptions({ skipTenantFilter: true } as any)
      .sort({ _id: 1 }) // deterministic order for batch processing
      .exec();
    return docs.map((d) => this.toDomain(d));
  }

  /**
   * Atomic health status update. Called by Health Check service.
   * Skips tenant filter (cronjob context).
   */
  async updateHealthStatus(
    id: string,
    update: {
      status?: string;
      lastVerifiedAt?: Date;
      lastHealthError?: string | null;
      consecutiveFailures?: number;
      healthState?: string;
      nextHealthCheckAt?: Date | null;
    },
  ): Promise<void> {
    await this.model
      .findOneAndUpdate({ _id: id, deletedAt: null }, { $set: update })
      .setOptions({ skipTenantFilter: true } as any)
      .exec();
  }

  /**
   * Find configs that are DUE for adaptive health check.
   * Returns configs where nextHealthCheckAt <= now AND not disabled/deleted.
   * Limited to 100 per run to prevent overload.
   */
  async findDueForAdaptiveCheck(now: Date): Promise<ChannelConfig[]> {
    const docs = await this.model
      .find({
        deletedAt: null,
        status: { $ne: 'disabled' },
        nextHealthCheckAt: { $lte: now },
      })
      .select('+encryptedCredentials')
      .setOptions({ skipTenantFilter: true } as any)
      .sort({ nextHealthCheckAt: 1 })
      .limit(100) // Cap per run to prevent overload
      .exec();
    return docs.map((d) => this.toDomain(d));
  }

  // ── Mapper ────────────────────────────────────────────────────────────────

  private toDomain(raw: ChannelConfigSchemaClass): ChannelConfig {
    const entity = new ChannelConfig();
    entity.id = raw._id?.toString();
    entity.tenantId = raw.tenantId?.toString();
    entity.providerType = raw.providerType;
    entity.name = raw.name;
    entity.isDefault = raw.isDefault;
    entity.status = raw.status;
    entity.publicSettings = raw.publicSettings || {};
    entity.deletedAt = raw.deletedAt;
    // Health Check Metadata (Phase 2)
    entity.lastVerifiedAt = raw.lastVerifiedAt || null;
    entity.lastHealthError = raw.lastHealthError || null;
    entity.consecutiveFailures = raw.consecutiveFailures || 0;
    // Adaptive Health Check (Phase 3)
    entity.healthState = (raw as any).healthState || 'healthy';
    entity.nextHealthCheckAt = (raw as any).nextHealthCheckAt || null;
    entity.createdAt = raw.createdAt;
    entity.updatedAt = raw.updatedAt;
    if (raw.encryptedCredentials) {
      entity.encryptedCredentials = raw.encryptedCredentials;
    }
    return entity;
  }
}
