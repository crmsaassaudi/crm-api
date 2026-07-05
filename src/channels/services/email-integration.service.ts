import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import {
  ReconnectEmailIntegrationDto,
  TestEmailSyncDto,
  UpdateEmailIntegrationSettingsDto,
} from '../dto/email-integration.dto';
import { AdapterRegistryService } from '../adapters/adapter-registry.service';
import { ChannelConfigService } from '../channel-config.service';
import { EmailChannelSettingsService } from './email-channel-settings.service';
import { HistoricalSyncService } from './historical-sync.service';
import { ChannelConfigRepository } from '../infrastructure/persistence/document/repositories/channel-config.repository';
import { CRYPTO_SERVICE_TOKEN, ICryptoService } from '../domain/crypto.service';

@Injectable()
export class EmailIntegrationService {
  private readonly logger = new Logger(EmailIntegrationService.name);

  constructor(
    private readonly cls: ClsService,
    private readonly configRepo: ChannelConfigRepository,
    private readonly channelConfigService: ChannelConfigService,
    private readonly adapterRegistry: AdapterRegistryService,
    private readonly emailSettings: EmailChannelSettingsService,
    private readonly historicalSync: HistoricalSyncService,
    private readonly eventEmitter: EventEmitter2,
    @Inject(CRYPTO_SERVICE_TOKEN)
    private readonly crypto: ICryptoService,
  ) {}

  async getHealth(id: string) {
    const tenantId = this.getTenantId();
    const config = await this.getEmailConfig(tenantId, id);
    const status = this.toMailboxHealthStatus(config);

    return {
      id: config.id,
      name: config.name,
      providerType: config.providerType,
      status,
      healthState: config.healthState ?? 'healthy',
      lastVerifiedAt: config.lastVerifiedAt,
      lastHealthError: config.lastHealthError,
      consecutiveFailures: config.consecutiveFailures ?? 0,
      isDefault: config.isDefault,
      inboundSyncEnabled: Boolean(config.publicSettings?.imapHost),
      syncTargetFolders:
        await this.emailSettings.getSyncTargetFolders(tenantId),
      settings: this.publicMailboxSettings(config.publicSettings ?? {}),
      needsAdminAction:
        status === 'token_expired' || status === 'error_needs_admin_action',
    };
  }

  async updateSettings(id: string, dto: UpdateEmailIntegrationSettingsDto) {
    const tenantId = this.getTenantId();
    const existing = await this.getEmailConfig(tenantId, id);
    const publicSettings = dto.publicSettings
      ? { ...(existing.publicSettings ?? {}), ...dto.publicSettings }
      : undefined;

    if (dto.emailSettings) {
      await this.emailSettings.updateSettings(
        dto.emailSettings as any,
        tenantId,
      );
    }

    const updated = await this.channelConfigService.update(id, {
      ...(dto.name ? { name: dto.name } : {}),
      ...(publicSettings ? { publicSettings } : {}),
    });

    this.eventEmitter.emit('email-integration.settings.updated', {
      tenantId,
      configId: id,
      changedFields: Object.keys(dto),
    });

    return updated;
  }

  async reconnect(id: string, dto: ReconnectEmailIntegrationDto) {
    const tenantId = this.getTenantId();
    const existing = await this.getEmailConfigWithCredentials(tenantId, id);
    const publicSettings = dto.publicSettings
      ? { ...(existing.publicSettings ?? {}), ...dto.publicSettings }
      : (existing.publicSettings ?? {});

    if (dto.credentials) {
      return this.channelConfigService.update(id, {
        credentials: dto.credentials,
        publicSettings,
      });
    }

    if (!existing.encryptedCredentials) {
      throw new BadRequestException(
        'No stored credentials found. Submit credentials to reconnect.',
      );
    }

    const credentials = JSON.parse(
      await this.crypto.decrypt(existing.encryptedCredentials),
    );
    const result = await this.adapterRegistry.verify(
      existing.providerType,
      credentials,
      publicSettings,
    );

    if (!result.success) {
      await this.configRepo.update(tenantId, id, {
        status: 'error',
        lastHealthError: result.error ?? 'Connection verification failed',
        consecutiveFailures: (existing.consecutiveFailures ?? 0) + 1,
        healthState: 'unhealthy',
      } as any);
      throw new BadRequestException(
        `Connection verification failed: ${result.error ?? 'Unknown error'}`,
      );
    }

    const updated = await this.configRepo.update(tenantId, id, {
      status: 'active',
      publicSettings,
      lastVerifiedAt: new Date(),
      lastHealthError: null,
      consecutiveFailures: 0,
      healthState: 'healthy',
      nextHealthCheckAt: null,
    } as any);

    this.eventEmitter.emit('channel-config.updated', {
      configId: id,
      configName: existing.name,
    });
    this.emitAudit('reconnect', {
      configId: id,
      configName: existing.name,
      providerType: existing.providerType,
      changes: { result: 'success', usedStoredCredentials: !dto.credentials },
    });

    this.logger.log(`[EmailIntegration] Reconnected config ${id}`);
    return updated;
  }

  async testSync(id: string, dto: TestEmailSyncDto) {
    const tenantId = this.getTenantId();
    const config = await this.getEmailConfigWithCredentials(tenantId, id);
    const publicSettings = config.publicSettings || {};

    if (!publicSettings.imapHost) {
      throw new BadRequestException(
        'IMAP host is not configured for this mailbox.',
      );
    }
    if (!config.encryptedCredentials) {
      throw new BadRequestException('No stored credentials found.');
    }

    const credentials = JSON.parse(
      await this.crypto.decrypt(config.encryptedCredentials),
    );
    const verify = await this.adapterRegistry.verify(
      config.providerType,
      credentials,
      publicSettings,
    );
    if (!verify.success) {
      this.emitAudit('test-sync', {
        configId: id,
        configName: config.name,
        providerType: config.providerType,
        changes: { result: 'failure', error: verify.error ?? 'Unknown error' },
      });
      throw new BadRequestException(
        `Connection verification failed: ${verify.error ?? 'Unknown error'}`,
      );
    }

    let syncJob: { jobId: string } | null = null;
    if (dto.startBackfill) {
      syncJob = await this.historicalSync.startSync({
        tenantId,
        configId: id,
        mode: dto.mode ?? 'auto_discover',
        maxAgeDays: dto.maxAgeDays ?? 7,
        maxThreads: dto.maxThreads ?? 50,
      });
    }

    this.emitAudit('test-sync', {
      configId: id,
      configName: config.name,
      providerType: config.providerType,
      changes: {
        result: 'success',
        imapReady: true,
        startedBackfill: Boolean(dto.startBackfill),
        syncJobId: syncJob?.jobId ?? null,
      },
    });

    return {
      ok: true,
      configId: id,
      smtpVerified: true,
      imapReady: true,
      syncJob,
      checkedAt: new Date(),
    };
  }

  private getTenantId(): string {
    const tenantId = this.cls.get('tenantId');
    if (!tenantId) throw new BadRequestException('Missing tenant context');
    return tenantId;
  }

  private async getEmailConfig(tenantId: string, id: string) {
    const config = await this.configRepo.findById(tenantId, id);
    if (!config) throw new NotFoundException('Email integration not found');
    if (config.providerType !== 'smtp') {
      throw new BadRequestException(
        'This endpoint only supports email integrations.',
      );
    }
    return config;
  }

  private async getEmailConfigWithCredentials(tenantId: string, id: string) {
    const config = await this.configRepo.findByIdWithCredentials(tenantId, id);
    if (!config) throw new NotFoundException('Email integration not found');
    if (config.providerType !== 'smtp') {
      throw new BadRequestException(
        'This endpoint only supports email integrations.',
      );
    }
    return config;
  }

  private toMailboxHealthStatus(config: {
    status: string;
    lastHealthError?: string | null;
  }):
    | 'connected'
    | 'syncing'
    | 'token_expired'
    | 'disconnected'
    | 'error_needs_admin_action' {
    if (config.status === 'active') return 'connected';
    if (config.status === 'disabled') return 'disconnected';
    const error = (config.lastHealthError || '').toLowerCase();
    if (
      error.includes('auth') ||
      error.includes('credential') ||
      error.includes('token') ||
      error.includes('password')
    ) {
      return 'token_expired';
    }
    return 'error_needs_admin_action';
  }

  private publicMailboxSettings(settings: Record<string, any>) {
    const safe = { ...settings };
    delete safe.user;
    delete safe.password;
    delete safe.apiKey;
    delete safe.authToken;
    return safe;
  }

  private emitAudit(
    action: 'reconnect' | 'test-sync',
    data: {
      configId: string;
      configName: string;
      providerType?: string;
      changes?: Record<string, any>;
    },
  ): void {
    this.eventEmitter.emit(`channel-config.audit.${action}`, {
      ...data,
      tenantId: this.cls.get('tenantId'),
      userId: this.cls.get('userId') ?? 'system',
      ipAddress: this.cls.get('clientIp') ?? null,
      userAgent: this.cls.get('userAgent') ?? null,
    });
  }
}
