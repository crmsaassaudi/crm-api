import { Injectable, Logger, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { SalesGateway } from '../modules/realtime/gateways/sales.gateway';
import { AutomationWorkflowRepository } from '../automation-rules/infrastructure/persistence/document/repositories/automation-workflow.repository';

/**
 * Channel Alert Service — Handles real-time notifications for channel config issues.
 *
 * Subscribes to events from:
 *   - ChannelHealthCheckService (proactive cron verification)
 *   - ActionExecutors (runtime permanent failures)
 *
 * Alert channels (Phase 2):
 *   1. Structured Logger — for centralized logging (Datadog/ELK)
 *   2. WebSocket push — for admin currently online (via SalesGateway)
 *
 * WebSocket event format:
 *   event: 'channel:config:alert'
 *   room:  'tenant:{tenantId}'  (frontend filters by user role)
 *   payload: { type, configId, configName, providerType, error, timestamp }
 *
 * Future Phase 3:
 *   - In-app notification module (persistent, with read/unread status)
 *   - Email notification to tenant admin
 */
@Injectable()
export class ChannelAlertService {
  private readonly logger = new Logger(ChannelAlertService.name);

  // ── Flap Detection: prevent notification spam ──────────────────────────
  // Max 1 alert per config per 30 minutes (in-memory, per-node).
  // If scaling to multi-node, migrate to Redis SET with TTL.
  private readonly alertCooldowns = new Map<string, number>();
  private readonly ALERT_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

  constructor(
    private readonly salesGateway: SalesGateway,
    @Optional() private readonly workflowRepo?: AutomationWorkflowRepository,
  ) {}

  // ── Health Check Failed ──────────────────────────────────────────────────

  @OnEvent('channel-config.health.failed')
  handleHealthCheckFailed(payload: {
    configId: string;
    configName: string;
    providerType: string;
    tenantId: string;
    error: string;
    consecutiveFailures: number;
    statusChanged: boolean;
  }): void {
    // 1. Structured log
    this.logger.warn(
      `[ALERT] Channel config health check FAILED | ` +
        `tenant=${payload.tenantId} config="${payload.configName}" ` +
        `provider=${payload.providerType} failures=${payload.consecutiveFailures} ` +
        `statusChanged=${payload.statusChanged} error="${payload.error}"`,
    );

    // 2. WebSocket push to tenant room (only when status actually changes to 'error')
    // Flap detection: cooldown prevents spam when config is flaky
    if (payload.statusChanged && this.shouldAlert(payload.configId)) {
      this.emitToTenant(payload.tenantId, {
        type: 'health_check_failed',
        severity: 'error',
        configId: payload.configId,
        configName: payload.configName,
        providerType: payload.providerType,
        error: payload.error,
        consecutiveFailures: payload.consecutiveFailures,
        message:
          `Channel configuration "${payload.configName}" has lost connection. ` +
          `Please update credentials in Settings > Channel Config.`,
        timestamp: new Date().toISOString(),
      });
    }

    // Phase 4: Notify workflow owners (marketers) about disrupted campaigns
    if (payload.statusChanged) {
      this.notifyWorkflowOwners(payload).catch((err) =>
        this.logger.error(
          `[ALERT] Failed to notify workflow owners: ${err.message}`,
        ),
      );
    }
  }

  // ── Health Check Recovered ───────────────────────────────────────────────

  @OnEvent('channel-config.health.recovered')
  handleHealthCheckRecovered(payload: {
    configId: string;
    configName: string;
    providerType: string;
    tenantId: string;
  }): void {
    this.logger.log(
      `[ALERT] Channel config RECOVERED | ` +
        `tenant=${payload.tenantId} config="${payload.configName}" ` +
        `provider=${payload.providerType}`,
    );

    this.emitToTenant(payload.tenantId, {
      type: 'health_check_recovered',
      severity: 'info',
      configId: payload.configId,
      configName: payload.configName,
      providerType: payload.providerType,
      message: `Channel configuration "${payload.configName}" has been restored.`,
      timestamp: new Date().toISOString(),
    });
  }

  // ── Health Check Summary ─────────────────────────────────────────────────

  @OnEvent('channel-config.health.summary')
  handleHealthCheckSummary(payload: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    durationMs: number;
  }): void {
    this.logger.log(
      `[ALERT] Health check summary: ` +
        `total=${payload.total} passed=${payload.passed} ` +
        `failed=${payload.failed} skipped=${payload.skipped} ` +
        `duration=${payload.durationMs}ms`,
    );
  }

  // ── Private: WebSocket Emit ──────────────────────────────────────────────

  /**
   * Emit alert to all connected users of a tenant.
   * Frontend filters by user role (only show to users with manage_channel_configs permission).
   */
  private emitToTenant(tenantId: string, payload: Record<string, any>): void {
    try {
      // Re-use existing BaseGateway infrastructure
      // Emit to a tenant-scoped room (tenant:{tenantId})
      // Note: For Phase 2, we emit via the SalesGateway's server instance
      // Since SalesGateway extends BaseGateway, we can access server.to()
      if (this.salesGateway?.server) {
        const room = `tenant:${tenantId}`;
        this.salesGateway.server.to(room).emit('channel:config:alert', payload);
        this.logger.debug(
          `[ALERT] WebSocket emitted to room ${room}: ${payload.type}`,
        );
      } else {
        this.logger.debug(
          '[ALERT] WebSocket server not available — alert logged only',
        );
      }
    } catch (error: any) {
      // Never let alert delivery failure crash the health check
      this.logger.error(`[ALERT] Failed to emit WebSocket: ${error.message}`);
    }
  }

  // -- Marketer Alert: Notify workflow owners about disrupted campaigns --

  /**
   * Find all active workflows using the failed configId and emit
   * targeted WebSocket events to each workflow owner (createdBy).
   *
   * This ensures marketers (who set up campaigns) get notified directly,
   * not just system admins.
   */
  private async notifyWorkflowOwners(payload: {
    configId: string;
    configName: string;
    tenantId: string;
    error: string;
  }): Promise<void> {
    if (!this.workflowRepo || !this.salesGateway?.server) return;

    try {
      const activeWorkflows = await this.workflowRepo.findByStatus(
        payload.tenantId,
        'active',
      );

      // Filter to workflows that reference this configId
      const affectedWorkflows = activeWorkflows.filter((w: any) => {
        const nodes = w.publishedNodes || [];
        return nodes.some(
          (node: any) =>
            node.type === 'action' &&
            node.config?.configId === payload.configId,
        );
      });

      if (affectedWorkflows.length === 0) return;

      // Collect unique owners
      const ownerIds = new Set<string>();
      for (const wf of affectedWorkflows as any[]) {
        if (wf.createdBy) ownerIds.add(wf.createdBy.toString());
      }

      // Emit per-workflow alert to tenant room (frontend filters by owner)
      for (const wf of affectedWorkflows as any[]) {
        this.salesGateway.server
          .to(`tenant:${payload.tenantId}`)
          .emit('workflow:config:alert', {
            type: 'workflow_disrupted',
            severity: 'warning',
            workflowId: wf._id?.toString() || wf.id,
            workflowName: wf.name,
            configId: payload.configId,
            configName: payload.configName,
            error: payload.error,
            ownerId: wf.createdBy?.toString() || null,
            message:
              `Workflow "${wf.name}" is disrupted because channel config ` +
              `"${payload.configName}" has failed. Check Settings > Channel Config.`,
            timestamp: new Date().toISOString(),
          });
      }

      this.logger.log(
        `[ALERT] Notified ${ownerIds.size} workflow owner(s) about ${affectedWorkflows.length} disrupted workflow(s) ` +
          `due to config "${payload.configName}" failure`,
      );
    } catch (error: any) {
      this.logger.error(
        `[ALERT] Failed to notify workflow owners: ${error.message}`,
      );
    }
  }

  // -- Flap Detection --

  /**
   * Check if we should send an alert for this config.
   * Returns false if an alert was sent within the cooldown period (30 min).
   * Prevents notification spam when configs are flaky (network jitter).
   */
  private shouldAlert(configId: string): boolean {
    const lastAlert = this.alertCooldowns.get(configId) || 0;
    const now = Date.now();

    if (now - lastAlert < this.ALERT_COOLDOWN_MS) {
      this.logger.debug(
        `[ALERT] Cooldown active for config ${configId} — skipping WebSocket alert`,
      );
      return false;
    }

    this.alertCooldowns.set(configId, now);

    // Periodic cleanup: remove entries older than 2x cooldown to prevent memory leak
    if (this.alertCooldowns.size > 100) {
      const cutoff = now - this.ALERT_COOLDOWN_MS * 2;
      for (const [key, timestamp] of this.alertCooldowns) {
        if (timestamp < cutoff) this.alertCooldowns.delete(key);
      }
    }

    return true;
  }
}
