import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ChannelConfigAuditRepository } from './infrastructure/persistence/document/repositories/channel-config-audit.repository';

/**
 * Event payload emitted by ChannelConfigService for audit tracking.
 */
export interface ChannelConfigAuditEvent {
  configId: string;
  configName: string;
  providerType?: string | null;
  tenantId: string;
  userId: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  changes?: Record<string, any>;
}

/**
 * ChannelConfigAuditService -- Event-driven audit logging for compliance.
 *
 * Listens to channel-config lifecycle events and persists audit entries.
 * Follows the fire-and-forget pattern: audit failures are logged but never
 * block the main operation (create/update/delete).
 *
 * WHO changed WHAT, WHEN, from WHERE:
 *   - userId: from CLS context (set by TenantInterceptor)
 *   - ipAddress/userAgent: from request context (set by controller)
 *   - configId + changes: from event payload
 *
 * Retention: 90 days hot (MongoDB TTL), 1 year cold (S3 archive future).
 */
@Injectable()
export class ChannelConfigAuditService {
  private readonly logger = new Logger(ChannelConfigAuditService.name);

  constructor(private readonly auditRepo: ChannelConfigAuditRepository) {}

  // -- Lifecycle Event Handlers --

  @OnEvent('channel-config.audit.created')
  async handleCreated(payload: ChannelConfigAuditEvent): Promise<void> {
    await this.writeLog('create', payload);
  }

  @OnEvent('channel-config.audit.updated')
  async handleUpdated(payload: ChannelConfigAuditEvent): Promise<void> {
    await this.writeLog('update', payload);
  }

  @OnEvent('channel-config.audit.deleted')
  async handleDeleted(payload: ChannelConfigAuditEvent): Promise<void> {
    await this.writeLog('delete', payload);
  }

  @OnEvent('channel-config.audit.set-default')
  async handleSetDefault(payload: ChannelConfigAuditEvent): Promise<void> {
    await this.writeLog('set_default', payload);
  }

  @OnEvent('channel-config.audit.verified')
  async handleVerified(payload: ChannelConfigAuditEvent): Promise<void> {
    await this.writeLog('verify', payload);
  }

  @OnEvent('channel-config.audit.reconnect')
  async handleReconnect(payload: ChannelConfigAuditEvent): Promise<void> {
    await this.writeLog('reconnect', payload);
  }

  @OnEvent('channel-config.audit.test-sync')
  async handleTestSync(payload: ChannelConfigAuditEvent): Promise<void> {
    await this.writeLog('test_sync', payload);
  }

  @OnEvent('channel-config.audit.label-reconcile')
  async handleLabelReconcile(payload: ChannelConfigAuditEvent): Promise<void> {
    await this.writeLog('label_reconcile', payload);
  }

  @OnEvent('channel-config.health.failed')
  async handleHealthFailed(payload: {
    configId: string;
    configName: string;
    providerType?: string | null;
    tenantId: string;
    error?: string;
    consecutiveFailures?: number;
    statusChanged?: boolean;
  }): Promise<void> {
    await this.writeLog('health_check', {
      ...payload,
      userId: 'system',
      changes: {
        result: 'failure',
        error: payload.error,
        consecutiveFailures: payload.consecutiveFailures,
        statusChanged: payload.statusChanged,
      },
    });
  }

  @OnEvent('channel-config.health.recovered')
  async handleHealthRecovered(payload: {
    configId: string;
    configName: string;
    providerType?: string | null;
    tenantId: string;
  }): Promise<void> {
    await this.writeLog('health_check', {
      ...payload,
      userId: 'system',
      changes: { result: 'success', recovered: true },
    });
  }

  // -- Core Write --

  private async writeLog(
    action: string,
    payload: ChannelConfigAuditEvent,
  ): Promise<void> {
    try {
      await this.auditRepo.create({
        tenantId: payload.tenantId,
        userId: payload.userId,
        configId: payload.configId,
        action,
        configName: payload.configName,
        providerType: payload.providerType || null,
        changes: payload.changes || {},
        ipAddress: payload.ipAddress || null,
        userAgent: payload.userAgent || null,
      });

      this.logger.debug(
        `[Audit] ${action.toUpperCase()} | config="${payload.configName}" ` +
          `user=${payload.userId} tenant=${payload.tenantId}`,
      );
    } catch (error: any) {
      // Never let audit failures block the main operation
      this.logger.error(
        `[Audit] Failed to write ${action} log for config="${payload.configName}": ${error.message}`,
      );
    }
  }
}
