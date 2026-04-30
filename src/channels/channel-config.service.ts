import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  BadRequestException,
  Inject,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { ChannelConfigRepository } from './infrastructure/persistence/document/repositories/channel-config.repository';
import { ChannelConfig } from './domain/channel-config';
import {
  VerifyAndSaveChannelConfigDto,
  UpdateChannelConfigDto,
} from './dto/channel-config.dto';
import {
  PROVIDER_REGISTRY,
  getProviderSchema,
  ProviderSchema,
} from './domain/channel-provider-registry';
import { ICryptoService, CRYPTO_SERVICE_TOKEN } from './domain/crypto.service';
import { AdapterRegistryService } from './adapters/adapter-registry.service';
import { AutomationWorkflowRepository } from '../automation-rules/infrastructure/persistence/document/repositories/automation-workflow.repository';

@Injectable()
export class ChannelConfigService {
  private readonly logger = new Logger(ChannelConfigService.name);

  constructor(
    private readonly repository: ChannelConfigRepository,
    private readonly cls: ClsService,
    private readonly adapterRegistry: AdapterRegistryService,
    @Inject(CRYPTO_SERVICE_TOKEN)
    private readonly crypto: ICryptoService,
    private readonly workflowRepository: AutomationWorkflowRepository,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ── Provider Schema Registry ────────────────────────────────────────────

  getProviderSchemas(): ProviderSchema[] {
    return PROVIDER_REGISTRY;
  }

  // ── CRUD ────────────────────────────────────────────────────────────────

  async findAll(): Promise<ChannelConfig[]> {
    const tenant = this.cls.get('tenantId');
    return this.repository.findAllByTenant(tenant);
  }

  async findById(id: string): Promise<ChannelConfig> {
    const tenant = this.cls.get('tenantId');
    const config = await this.repository.findById(tenant, id);
    if (!config) throw new NotFoundException('Channel config not found');
    return config;
  }

  // ── Verify & Save (Core Flow) ───────────────────────────────────────────

  async verifyAndSave(
    dto: VerifyAndSaveChannelConfigDto,
  ): Promise<ChannelConfig> {
    const tenant = this.cls.get('tenantId');

    // 1. Validate provider type exists in registry
    const schema = getProviderSchema(dto.providerType);
    if (!schema) {
      throw new BadRequestException(
        `Unknown provider type: ${dto.providerType}`,
      );
    }

    // 2. Validate required fields
    this.validateRequiredFields(schema, dto.credentials, dto.publicSettings);

    // 3. Verify connection via adapter
    this.logger.log(
      `[ChannelConfig] Verifying connection for ${dto.providerType} (tenant=${tenant})`,
    );
    const result = await this.adapterRegistry.verify(
      dto.providerType,
      dto.credentials,
      dto.publicSettings || {},
    );

    if (!result.success) {
      throw new BadRequestException(
        `Connection verification failed: ${result.error}`,
      );
    }

    // 4. Encrypt credentials (async — KMS requires network call)
    const encryptedCredentials = await this.crypto.encrypt(
      JSON.stringify(dto.credentials),
    );

    // 5. Save to DB
    const config = await this.repository.create({
      tenantId: tenant,
      providerType: dto.providerType,
      name: dto.name,
      encryptedCredentials,
      publicSettings: dto.publicSettings || {},
      status: 'active',
      isDefault: dto.isDefault || false,
      deletedAt: null,
      lastVerifiedAt: new Date(), // Verified at creation time
      lastHealthError: null,
      consecutiveFailures: 0,
    });

    // 6. If set as default, unset others
    if (dto.isDefault) {
      await this.repository.setDefault(tenant, config.id, dto.providerType);
    }

    this.logger.log(
      `[ChannelConfig] Created config: ${config.name} (${dto.providerType}) id=${config.id}`,
    );

    // Audit trail: record creation
    this.emitAuditEvent('created', {
      configId: config.id,
      configName: config.name,
      providerType: dto.providerType,
      changes: {
        providerType: dto.providerType,
        name: dto.name,
        isDefault: dto.isDefault || false,
      },
    });

    // Strip credentials before returning
    delete config.encryptedCredentials;
    return config;
  }

  // ── Update ──────────────────────────────────────────────────────────────

  async update(
    id: string,
    dto: UpdateChannelConfigDto,
  ): Promise<ChannelConfig> {
    const tenant = this.cls.get('tenantId');

    const existing = await this.repository.findByIdWithCredentials(tenant, id);
    if (!existing) throw new NotFoundException('Channel config not found');

    const updateData: Partial<ChannelConfig> = {};

    if (dto.name) updateData.name = dto.name;
    if (dto.publicSettings) updateData.publicSettings = dto.publicSettings;
    if (dto.status) updateData.status = dto.status;

    // If credentials changed, re-verify and re-encrypt
    if (dto.credentials) {
      const schema = getProviderSchema(existing.providerType);
      if (!schema) {
        throw new BadRequestException(
          `Unknown provider type: ${existing.providerType}`,
        );
      }

      const settings = dto.publicSettings || existing.publicSettings || {};
      const result = await this.adapterRegistry.verify(
        existing.providerType,
        dto.credentials,
        settings,
      );

      if (!result.success) {
        throw new BadRequestException(
          `Connection verification failed: ${result.error}`,
        );
      }

      updateData.encryptedCredentials = await this.crypto.encrypt(
        JSON.stringify(dto.credentials),
      );
      updateData.status = 'active'; // Reset status on successful re-verification
      updateData.lastVerifiedAt = new Date();
      updateData.lastHealthError = null;
      updateData.consecutiveFailures = 0;
      // Reset adaptive health check state on successful re-verification
      (updateData as any).healthState = 'healthy';
      (updateData as any).nextHealthCheckAt = null;
    }

    const updated = await this.repository.update(tenant, id, updateData);
    if (!updated) throw new NotFoundException('Channel config not found');

    // Invalidate TransportPool cache — event-driven invalidation
    this.eventEmitter.emit('channel-config.updated', {
      configId: id,
      configName: updated.name,
    });

    // Audit trail: record update with changed fields
    const changedFields = Object.keys(updateData).filter(
      (k) => k !== 'encryptedCredentials',
    );
    if (dto.credentials) changedFields.push('credentials');
    this.emitAuditEvent('updated', {
      configId: id,
      configName: updated.name,
      providerType: existing.providerType,
      changes: { changedFields },
    });

    this.logger.log(
      `[ChannelConfig] Updated config: ${updated.name} (id=${id})`,
    );

    delete updated.encryptedCredentials;
    return updated;
  }

  // ── Soft Delete (with Proactive Validation) ─────────────────────────────

  async softDelete(
    id: string,
  ): Promise<{ deleted: boolean; warning?: string }> {
    const tenant = this.cls.get('tenantId');

    const config = await this.repository.findById(tenant, id);
    if (!config) throw new NotFoundException('Channel config not found');

    // Proactive Validation: Check if any active workflows reference this config
    const referencingWorkflows = await this.findWorkflowsUsingConfig(
      tenant,
      id,
    );

    if (referencingWorkflows.length > 0) {
      const names = referencingWorkflows.map((w) => w.name).join(', ');
      throw new ConflictException(
        `Cannot delete: This configuration is used by active workflow(s): ${names}. ` +
          `Please update or deactivate those workflows first.`,
      );
    }

    // Check draft-only references (allow with warning)
    const draftReferences = await this.findDraftWorkflowsUsingConfig(
      tenant,
      id,
    );
    const warning =
      draftReferences.length > 0
        ? `Note: ${draftReferences.length} draft workflow(s) reference this config. ` +
          `They will need to be updated before publishing.`
        : undefined;

    await this.repository.softDelete(tenant, id);

    // Invalidate TransportPool cache — event-driven invalidation
    this.eventEmitter.emit('channel-config.deleted', {
      configId: id,
      configName: config.name,
    });

    // Audit trail: record deletion
    this.emitAuditEvent('deleted', {
      configId: id,
      configName: config.name,
      providerType: config.providerType,
    });

    this.logger.log(
      `[ChannelConfig] Soft-deleted config: ${config.name} (id=${id})`,
    );

    return { deleted: true, warning };
  }

  // ── Set Default ─────────────────────────────────────────────────────────

  async setDefault(id: string): Promise<ChannelConfig> {
    const tenant = this.cls.get('tenantId');

    const config = await this.repository.findById(tenant, id);
    if (!config) throw new NotFoundException('Channel config not found');

    await this.repository.setDefault(tenant, id, config.providerType);

    // Invalidate pool for all configs of this provider type (default flag changed)
    this.eventEmitter.emit('channel-config.updated', {
      configId: id,
      configName: config.name,
    });

    // Audit trail
    this.emitAuditEvent('set-default', {
      configId: id,
      configName: config.name,
      providerType: config.providerType,
      changes: { providerType: config.providerType },
    });

    return { ...config, isDefault: true };
  }

  // -- Pre-Delete Check (Phase 2: Migration Flow) --

  /**
   * Check what would be affected if this config were deleted.
   * Returns affected workflows and compatible fallback configs.
   */
  async preDeleteCheck(id: string): Promise<{
    canDelete: boolean;
    configName: string;
    providerType: string;
    affectedWorkflows: { id: string; name: string; nodeCount: number }[];
    compatibleConfigs: { id: string; name: string; providerType: string }[];
  }> {
    const tenant = this.cls.get('tenantId');
    const config = await this.repository.findById(tenant, id);
    if (!config) throw new NotFoundException('Channel config not found');

    // Find all active workflows referencing this config
    const activeWorkflows = await this.findWorkflowsUsingConfig(tenant, id);
    const affectedWorkflows = activeWorkflows.map((w: any) => {
      const nodes = (w.publishedNodes || []).filter(
        (n: any) => n.type === 'action' && n.config?.configId === id,
      );
      return {
        id: w._id?.toString() || w.id,
        name: w.name,
        nodeCount: nodes.length,
      };
    });

    // Find compatible fallback configs (same providerType, active, not this one)
    const allConfigs = await this.repository.findAllByTenant(tenant);
    const compatibleConfigs = allConfigs
      .filter(
        (c) =>
          c.id !== id &&
          c.providerType === config.providerType &&
          c.status === 'active',
      )
      .map((c) => ({ id: c.id, name: c.name, providerType: c.providerType }));

    return {
      canDelete: affectedWorkflows.length === 0,
      configName: config.name,
      providerType: config.providerType,
      affectedWorkflows,
      compatibleConfigs,
    };
  }

  /**
   * Migrate all workflow references from sourceConfig to targetConfig,
   * then soft-delete the source. Uses MongoDB transaction for atomicity.
   */
  async migrateAndDelete(
    sourceConfigId: string,
    targetConfigId: string,
  ): Promise<{ migratedWorkflows: number; deleted: boolean }> {
    const tenant = this.cls.get('tenantId');

    // Validate both configs exist and belong to tenant
    const source = await this.repository.findById(tenant, sourceConfigId);
    if (!source) throw new NotFoundException('Source config not found');

    const target = await this.repository.findById(tenant, targetConfigId);
    if (!target) throw new NotFoundException('Target config not found');

    if (target.status !== 'active') {
      throw new BadRequestException(
        'Target config must be in active state for migration.',
      );
    }

    // Migrate workflow references via repository (uses MongoDB transaction)
    let migratedCount = 0;
    try {
      migratedCount = await this.workflowRepository.replaceConfigIdInNodes(
        tenant,
        sourceConfigId,
        targetConfigId,
      );
    } catch (err: any) {
      this.logger.error(
        `[ChannelConfig] Migration failed for ${source.name} -> ${target.name}: ${err.message}`,
      );
      throw new ConflictException(
        `Migration failed: ${err.message}. No changes were made.`,
      );
    }

    // Soft-delete the source config
    await this.repository.softDelete(tenant, sourceConfigId);

    // Invalidate pool cache
    this.eventEmitter.emit('channel-config.deleted', {
      configId: sourceConfigId,
      configName: source.name,
    });

    // Audit trail: record migration + deletion
    this.emitAuditEvent('deleted', {
      configId: sourceConfigId,
      configName: source.name,
      providerType: source.providerType,
      changes: {
        action: 'migrate_and_delete',
        targetConfigId,
        targetConfigName: target.name,
        migratedWorkflows: migratedCount,
      },
    });

    this.logger.log(
      `[ChannelConfig] Migrated ${migratedCount} workflow(s) from "${source.name}" to "${target.name}" and deleted source.`,
    );

    return { migratedWorkflows: migratedCount, deleted: true };
  }

  // ── Private Helpers ─────────────────────────────────────────────────────

  private validateRequiredFields(
    schema: ProviderSchema,
    credentials: Record<string, any>,
    settings?: Record<string, any>,
  ): void {
    const errors: string[] = [];

    for (const field of schema.credentialFields) {
      if (field.required && !credentials?.[field.key]) {
        errors.push(`${field.label} is required`);
      }
    }

    for (const field of schema.settingFields) {
      if (field.required && !settings?.[field.key]) {
        errors.push(`${field.label} is required`);
      }
    }

    if (errors.length > 0) {
      throw new BadRequestException(`Validation failed: ${errors.join(', ')}`);
    }
  }

  /**
   * Emit audit event with userId/IP from CLS context.
   * Fire-and-forget: never blocks the main operation.
   */
  private emitAuditEvent(
    action: string,
    data: {
      configId: string;
      configName: string;
      providerType?: string;
      changes?: Record<string, any>;
    },
  ): void {
    try {
      const tenantId = this.cls.get('tenantId');
      const userId = this.cls.get('userId') || 'system';
      const ipAddress = this.cls.get('clientIp') || null;
      const userAgent = this.cls.get('userAgent') || null;

      this.eventEmitter.emit(`channel-config.audit.${action}`, {
        ...data,
        tenantId,
        userId,
        ipAddress,
        userAgent,
      });
    } catch {
      // Silently ignore — audit should never crash the main flow
    }
  }

  /**
   * Scan active workflows' publishedNodes for configId references.
   */
  private async findWorkflowsUsingConfig(
    tenantId: string,
    configId: string,
  ): Promise<{ name: string }[]> {
    try {
      const workflows = await this.workflowRepository.findByStatus(
        tenantId,
        'active',
      );

      return workflows.filter((w: any) => {
        const nodes = w.publishedNodes || [];
        return nodes.some(
          (node: any) =>
            node.type === 'action' && node.config?.configId === configId,
        );
      });
    } catch {
      // If workflow repo is not available, skip validation
      return [];
    }
  }

  /**
   * Scan draft workflows' nodes for configId references.
   */
  private async findDraftWorkflowsUsingConfig(
    tenantId: string,
    configId: string,
  ): Promise<{ name: string }[]> {
    try {
      const workflows = await this.workflowRepository.findByStatus(
        tenantId,
        'draft',
      );

      return workflows.filter((w: any) => {
        const nodes = w.nodes || [];
        return nodes.some(
          (node: any) =>
            node.type === 'action' && node.config?.configId === configId,
        );
      });
    } catch {
      return [];
    }
  }
}
