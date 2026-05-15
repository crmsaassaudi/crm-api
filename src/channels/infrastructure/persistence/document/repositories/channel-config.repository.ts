import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  ChannelConfigSchemaClass,
  ChannelConfigSchemaDocument,
} from '../entities/channel-config.schema';
import { ChannelConfig } from '../../../../domain/channel-config';
import { getProviderSchema } from '../../../../domain/channel-provider-registry';

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
    await Promise.all(docs.map((doc) => this.migrateOnRead(doc)));
    return docs.map((d) => this.toDomain(d));
  }

  /**
   * Find by ID excluding credentials. For API responses.
   */
  async findById(tenantId: string, id: string): Promise<ChannelConfig | null> {
    const doc = await this.model
      .findOne({ _id: id, tenantId, deletedAt: null })
      .exec();
    if (doc) await this.migrateOnRead(doc);
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
      .select('+encryptedCredentials +accessToken +refreshToken')
      .exec();
    if (doc) await this.migrateOnRead(doc);
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
      .select('+encryptedCredentials +accessToken +refreshToken')
      .setOptions({ isPlatformQuery: true } as any)
      .exec();
    if (doc) await this.migrateOnRead(doc);
    return doc ? this.toDomain(doc) : null;
  }

  async create(data: Partial<ChannelConfig>): Promise<ChannelConfig> {
    const doc = await this.model.create(this.withCurrentSchema(data));
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
        { $set: this.withCurrentSchema(data) },
        { new: true },
      )
      .exec();
    return doc ? this.toDomain(doc) : null;
  }

  async updateOAuthTokens(
    id: string,
    data: {
      accessToken: string;
      refreshToken?: string | null;
      tokenExpiresAt: Date | null;
      authType?: string;
      encryptedCredentials?: string;
      publicSettings?: Record<string, any>;
      status?: string;
      lastVerifiedAt?: Date;
      lastHealthError?: string | null;
      consecutiveFailures?: number;
      healthState?: string;
      nextHealthCheckAt?: Date | null;
    },
  ): Promise<ChannelConfig | null> {
    const $set: Record<string, any> = {
      accessToken: data.accessToken,
      tokenExpiresAt: data.tokenExpiresAt,
      authType: data.authType || 'oauth2',
    };

    if (data.refreshToken !== undefined && data.refreshToken !== null) {
      $set.refreshToken = data.refreshToken;
    }
    if (data.encryptedCredentials !== undefined) {
      $set.encryptedCredentials = data.encryptedCredentials;
    }
    if (data.publicSettings !== undefined) {
      $set.publicSettings = this.withCurrentSchema({
        providerType: undefined,
        publicSettings: data.publicSettings,
      }).publicSettings;
    }
    if (data.status !== undefined) $set.status = data.status;
    if (data.lastVerifiedAt !== undefined) {
      $set.lastVerifiedAt = data.lastVerifiedAt;
    }
    if (data.lastHealthError !== undefined) {
      $set.lastHealthError = data.lastHealthError;
    }
    if (data.consecutiveFailures !== undefined) {
      $set.consecutiveFailures = data.consecutiveFailures;
    }
    if (data.healthState !== undefined) $set.healthState = data.healthState;
    if (data.nextHealthCheckAt !== undefined) {
      $set.nextHealthCheckAt = data.nextHealthCheckAt;
    }

    const doc = await this.model
      .findOneAndUpdate({ _id: id, deletedAt: null }, { $set }, { new: true })
      .select('+encryptedCredentials +accessToken +refreshToken')
      .setOptions({ isPlatformQuery: true } as any)
      .exec();
    if (doc) await this.migrateOnRead(doc);
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
      .select('+encryptedCredentials +accessToken +refreshToken')
      .setOptions({ isPlatformQuery: true } as any)
      .sort({ _id: 1 }) // deterministic order for batch processing
      .exec();
    await Promise.all(docs.map((doc) => this.migrateOnRead(doc)));
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
      .setOptions({ isPlatformQuery: true } as any)
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
      .select('+encryptedCredentials +accessToken +refreshToken')
      .setOptions({ isPlatformQuery: true } as any)
      .sort({ nextHealthCheckAt: 1 })
      .limit(100) // Cap per run to prevent overload
      .exec();
    await Promise.all(docs.map((doc) => this.migrateOnRead(doc)));
    return docs.map((d) => this.toDomain(d));
  }

  // ── Mapper ────────────────────────────────────────────────────────────────

  private toDomain(raw: ChannelConfigSchemaClass): ChannelConfig {
    const entity = new ChannelConfig();
    entity.id = raw._id?.toString();
    entity.tenantId = raw.tenantId?.toString();
    entity.providerType = raw.providerType;
    entity.schemaVersion = (raw as any).schemaVersion || 1;
    entity.name = raw.name;
    entity.isDefault = raw.isDefault;
    entity.status = raw.status;
    entity.publicSettings = raw.publicSettings || {};
    entity.authType = (raw as any).authType || 'app_password';
    entity.tokenExpiresAt = (raw as any).tokenExpiresAt || null;
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
    entity.accessToken = (raw as any).accessToken || null;
    entity.refreshToken = (raw as any).refreshToken || null;
    return entity;
  }

  private async migrateOnRead(doc: ChannelConfigSchemaDocument): Promise<void> {
    const update = this.computeSchemaEvolutionUpdate(doc);
    if (Object.keys(update).length === 0) return;

    await this.model
      .updateOne({ _id: doc._id }, { $set: update })
      .setOptions({ isPlatformQuery: true } as any)
      .exec();

    Object.assign(doc, update);
  }

  private withCurrentSchema(
    data: Partial<ChannelConfig>,
  ): Partial<ChannelConfig> {
    const providerType = data.providerType?.toLowerCase();
    const schema = providerType ? getProviderSchema(providerType) : undefined;
    const publicSettings = this.applyPublicSettingDefaults(
      providerType,
      data.publicSettings,
    );

    return {
      ...data,
      ...(providerType ? { providerType } : {}),
      ...(schema ? { schemaVersion: schema.schemaVersion } : {}),
      ...(publicSettings !== undefined ? { publicSettings } : {}),
    };
  }

  private computeSchemaEvolutionUpdate(
    raw: ChannelConfigSchemaClass,
  ): Record<string, any> {
    const update: Record<string, any> = {};
    const normalizedProviderType =
      typeof raw.providerType === 'string'
        ? raw.providerType.toLowerCase()
        : raw.providerType;

    if (normalizedProviderType && normalizedProviderType !== raw.providerType) {
      update.providerType = normalizedProviderType;
    }

    const schema = normalizedProviderType
      ? getProviderSchema(normalizedProviderType)
      : undefined;

    const currentVersion = (raw as any).schemaVersion || 1;
    if (schema && currentVersion < schema.schemaVersion) {
      update.schemaVersion = schema.schemaVersion;
    } else if (!(raw as any).schemaVersion) {
      update.schemaVersion = schema?.schemaVersion || 1;
    }

    if (!(raw as any).authType) update.authType = 'app_password';
    if (!(raw as any).status) update.status = 'active';
    if ((raw as any).isDefault === undefined) update.isDefault = false;
    if ((raw as any).consecutiveFailures === undefined) {
      update.consecutiveFailures = 0;
    }
    if (!(raw as any).healthState) update.healthState = 'healthy';

    const publicSettings = this.applyPublicSettingDefaults(
      normalizedProviderType,
      raw.publicSettings,
    );
    if (publicSettings && publicSettings !== raw.publicSettings) {
      update.publicSettings = publicSettings;
    }

    return update;
  }

  private applyPublicSettingDefaults(
    providerType?: string,
    publicSettings?: Record<string, any>,
  ): Record<string, any> | undefined {
    if (publicSettings === undefined && !providerType) return undefined;

    const schema = providerType ? getProviderSchema(providerType) : undefined;
    const next = { ...(publicSettings || {}) };
    let changed = publicSettings === undefined;

    for (const field of schema?.settingFields || []) {
      if (
        field.defaultValue !== undefined &&
        (next[field.key] === undefined || next[field.key] === null)
      ) {
        next[field.key] = field.defaultValue;
        changed = true;
      }
    }

    return changed ? next : publicSettings;
  }
}
