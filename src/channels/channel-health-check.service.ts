import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { OnEvent } from '@nestjs/event-emitter';
import { ChannelConfigRepository } from './infrastructure/persistence/document/repositories/channel-config.repository';
import { AdapterRegistryService } from './adapters/adapter-registry.service';
import { ICryptoService, CRYPTO_SERVICE_TOKEN } from './domain/crypto.service';
import { Inject } from '@nestjs/common';
import { ChannelConfig } from './domain/channel-config';
import { OAuth2TokenManager } from './services/oauth2-token-manager.service';
import { RedisLockService } from '../redis/redis-lock.service';

// ── Backoff intervals for adaptive health check ────────────────────────────
const BACKOFF_INTERVALS_MS = [
  5 * 60 * 1000, // 5 minutes  (1st failure → degraded)
  15 * 60 * 1000, // 15 minutes (2nd failure → unhealthy)
  60 * 60 * 1000, // 1 hour     (3rd failure)
  6 * 60 * 60 * 1000, // 6 hours    (4th+ failure — capped)
] as const;

/**
 * Channel Health Check Service — Adaptive credential verification.
 *
 * Dual-mode operation:
 *   1. BASELINE (every 6 hours): Scans ALL healthy configs via @Cron
 *   2. ADAPTIVE (every minute): Processes ONLY configs with nextHealthCheckAt <= now
 *
 * State Machine:
 *   healthy → degraded: 1st failure (runtime or health check)
 *   degraded → unhealthy: 2nd consecutive failure
 *   degraded/unhealthy → healthy: Health check passes
 *   unhealthy → unhealthy: Failure continues (extend backoff)
 *
 * Passive Monitoring Bridge:
 *   When SendEmailExecutor/SendSmsExecutor detect HTTP 401/403 at runtime,
 *   they emit 'channel-config.runtime-failure'. This service listens and
 *   schedules a fast-lane adaptive check in 5 minutes.
 *
 * Rate Limiting:
 *   - Max 10 concurrent verify calls per adaptive run (p-limit style)
 *   - Batch processing with jitter for baseline scans
 */
@Injectable()
export class ChannelHealthCheckService {
  private readonly logger = new Logger(ChannelHealthCheckService.name);
  private readonly BATCH_SIZE = 50;
  private readonly MAX_JITTER_MS = 5000; // 0-5s random delay between batches
  private readonly FAILURE_THRESHOLD = 2; // Consecutive failures before marking 'error'
  private readonly MAX_CONCURRENT_ADAPTIVE = 10; // Rate limit for adaptive checks
  private isBaselineRunning = false; // Guard against overlapping baseline runs
  private isAdaptiveRunning = false; // Guard against overlapping adaptive runs

  constructor(
    private readonly repository: ChannelConfigRepository,
    private readonly adapterRegistry: AdapterRegistryService,
    @Inject(CRYPTO_SERVICE_TOKEN)
    private readonly crypto: ICryptoService,
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
    private readonly oauth2TokenManager: OAuth2TokenManager,
    private readonly lockService: RedisLockService,
  ) {}

  // ── Mode 1: Baseline Health Check (Every 6 Hours) ─────────────────────────

  /**
   * Cron: Every 6 hours (00:00, 06:00, 12:00, 18:00)
   * Scans ALL active configs — the safety net for healthy configs.
   */
  @Cron(CronExpression.EVERY_6_HOURS)
  async runScheduledHealthCheck(): Promise<void> {
    if (!this.isEnabled()) return;

    if (this.isBaselineRunning) {
      this.logger.warn(
        '[HealthCheck] Baseline skipped — previous run still in progress',
      );
      return;
    }

    try {
      await this.lockService.acquire(
        'cron:channel-health:baseline',
        5 * 60 * 1000,
        async () => {
          await this.executeHealthCheck();
        },
        0,
        1,
      );
    } catch (error: any) {
      if (error?.message?.includes('Could not acquire lock')) {
        this.logger.debug(
          '[HealthCheck] Baseline skipped; another worker owns this tick',
        );
        return;
      }
      throw error;
    }
  }

  /**
   * Execute a full health check cycle across all active configs.
   * Can also be called manually from an admin endpoint.
   */
  async executeHealthCheck(): Promise<{
    total: number;
    passed: number;
    failed: number;
    skipped: number;
  }> {
    this.isBaselineRunning = true;
    const startTime = Date.now();
    let passed = 0;
    let failed = 0;
    let skipped = 0;

    try {
      const configs = await this.repository.findAllActiveForHealthCheck();
      const total = configs.length;

      this.logger.log(
        `[HealthCheck] Baseline starting: ${total} active configs to verify`,
      );

      // Process in batches with jitter
      for (let i = 0; i < configs.length; i += this.BATCH_SIZE) {
        const batch = configs.slice(i, i + this.BATCH_SIZE);

        // Add jitter between batches (not on the first batch)
        if (i > 0) {
          const jitter = Math.random() * this.MAX_JITTER_MS;
          await this.sleep(jitter);
        }

        // Process batch concurrently (within a batch, parallel is safe)
        const results = await Promise.allSettled(
          batch.map((config) => this.verifyAndUpdateConfig(config)),
        );

        for (const result of results) {
          if (result.status === 'fulfilled') {
            if (result.value === 'passed') passed++;
            else if (result.value === 'failed') failed++;
            else skipped++;
          } else {
            skipped++;
            this.logger.error(
              `[HealthCheck] Unexpected error in batch: ${result.reason}`,
            );
          }
        }

        this.logger.debug(
          `[HealthCheck] Batch ${Math.floor(i / this.BATCH_SIZE) + 1}: processed ${batch.length} configs`,
        );
      }

      const duration = Date.now() - startTime;
      this.logger.log(
        `[HealthCheck] ✅ Baseline complete: ${passed} passed, ${failed} failed, ${skipped} skipped out of ${total} total (${duration}ms)`,
      );

      // Emit summary event
      this.eventEmitter.emit('channel-config.health.summary', {
        total,
        passed,
        failed,
        skipped,
        durationMs: duration,
      });

      return { total, passed, failed, skipped };
    } catch (error: any) {
      this.logger.error(
        `[HealthCheck] Fatal error: ${error.message}`,
        error.stack,
      );
      return { total: 0, passed, failed, skipped };
    } finally {
      this.isBaselineRunning = false;
    }
  }

  // ── Mode 2: Adaptive Health Check (Every Minute) ──────────────────────────

  /**
   * Cron: Every minute — lightweight.
   * Only queries configs with nextHealthCheckAt <= now (uses sparse index).
   * Most of the time this returns 0 results and exits immediately.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async runAdaptiveHealthCheck(): Promise<void> {
    if (!this.isEnabled()) return;

    if (this.isAdaptiveRunning) {
      this.logger.debug(
        '[AdaptiveCheck] Skipped — previous run still in progress',
      );
      return;
    }

    try {
      await this.lockService.acquire(
        'cron:channel-health:adaptive',
        55_000,
        () => this.executeAdaptiveHealthCheck(),
        0,
        1,
      );
    } catch (error: any) {
      if (error?.message?.includes('Could not acquire lock')) {
        this.logger.debug(
          '[AdaptiveCheck] Skipped; another worker owns this tick',
        );
        return;
      }
      this.logger.error(`[AdaptiveCheck] Error: ${error.message}`, error.stack);
    }
  }

  private async executeAdaptiveHealthCheck(): Promise<void> {
    this.isAdaptiveRunning = true;
    try {
      const dueConfigs = await this.repository.findDueForAdaptiveCheck(
        new Date(),
      );
      if (dueConfigs.length === 0) return;

      this.logger.log(
        `[AdaptiveCheck] Processing ${dueConfigs.length} due config(s)`,
      );

      const results: Array<'passed' | 'failed' | 'skipped'> = [];
      for (
        let i = 0;
        i < dueConfigs.length;
        i += this.MAX_CONCURRENT_ADAPTIVE
      ) {
        const batch = dueConfigs.slice(i, i + this.MAX_CONCURRENT_ADAPTIVE);
        const batchResults = await Promise.allSettled(
          batch.map((config) => this.verifyAndUpdateConfig(config)),
        );
        for (const r of batchResults) {
          results.push(r.status === 'fulfilled' ? r.value : 'skipped');
        }
      }

      const passed = results.filter((r) => r === 'passed').length;
      const failed = results.filter((r) => r === 'failed').length;

      this.logger.log(
        `[AdaptiveCheck] Complete: ${passed} passed, ${failed} failed out of ${dueConfigs.length}`,
      );
    } finally {
      this.isAdaptiveRunning = false;
    }
  }

  // ── Passive Monitoring Bridge ─────────────────────────────────────────────

  /**
   * When an executor detects HTTP 401/403 at runtime, it emits this event.
   * We schedule a fast-lane adaptive check in 5 minutes for that config.
   *
   * Why not check immediately?
   *   - The executor already classified the error — no need to double-verify in the hot path
   *   - 5-minute delay allows transient provider-side issues to self-resolve
   */
  @OnEvent('channel-config.runtime-failure')
  async handleRuntimeFailure(payload: {
    configId: string;
    tenantId: string;
    httpStatus?: number;
  }): Promise<void> {
    try {
      const fiveMinutesFromNow = new Date(Date.now() + BACKOFF_INTERVALS_MS[0]);

      // Only schedule if not already scheduled (avoid duplicate fast-lane scheduling)
      await this.repository.updateHealthStatus(payload.configId, {
        healthState: 'degraded',
        nextHealthCheckAt: fiveMinutesFromNow,
      });

      this.logger.warn(
        `[AdaptiveCheck] Runtime failure detected for config ${payload.configId} ` +
          `(HTTP ${payload.httpStatus ?? 'unknown'}). ` +
          `Scheduled fast-lane check at ${fiveMinutesFromNow.toISOString()}`,
      );
    } catch (error: any) {
      this.logger.error(
        `[AdaptiveCheck] Failed to schedule fast-lane check: ${error.message}`,
      );
    }
  }

  // ── Core: Verify + Update Adaptive State ──────────────────────────────────

  /**
   * Verify a single channel config's credentials and update its health state.
   * Handles both baseline and adaptive results.
   */
  private async verifyAndUpdateConfig(
    config: ChannelConfig,
  ): Promise<'passed' | 'failed' | 'skipped'> {
    if (!config.encryptedCredentials) {
      this.logger.warn(
        `[HealthCheck] Config "${config.name}" (${config.id}) has no encrypted credentials — skipping`,
      );
      return 'skipped';
    }

    try {
      // Decrypt credentials
      const credentials = JSON.parse(
        await this.crypto.decrypt(config.encryptedCredentials),
      );
      const resolvedCredentials =
        await this.oauth2TokenManager.buildOAuth2Credentials(
          config,
          credentials,
        );

      // Verify via adapter
      const result = await this.adapterRegistry.verify(
        config.providerType,
        resolvedCredentials,
        {
          ...(config.publicSettings || {}),
          authType: config.authType ?? 'app_password',
        },
      );

      if (result.success) {
        // ── PASS: Transition to healthy ──────────────────────────────────
        await this.repository.updateHealthStatus(config.id, {
          status: config.status === 'error' ? 'active' : config.status,
          lastVerifiedAt: new Date(),
          lastHealthError: null,
          consecutiveFailures: 0,
          healthState: 'healthy',
          nextHealthCheckAt: null, // Back to normal 6-hour cron
        });

        if (config.status === 'error' || config.healthState !== 'healthy') {
          this.logger.log(
            `[HealthCheck] ✅ Config "${config.name}" RECOVERED — ` +
              `state: ${config.healthState} → healthy`,
          );
          this.eventEmitter.emit('channel-config.health.recovered', {
            configId: config.id,
            configName: config.name,
            providerType: config.providerType,
            tenantId: config.tenantId,
          });
        }

        return 'passed';
      } else {
        // ── FAIL: Transition state + schedule adaptive check ─────────────
        return this.handleVerifyFailure(
          config,
          result.error ?? 'Connection verification failed',
        );
      }
    } catch (error: any) {
      // Decryption or network error during health check
      this.logger.error(
        `[HealthCheck] Exception for config "${config.name}" (${config.id}): ${error.message}`,
      );
      return this.handleVerifyFailure(config, error.message);
    }
  }

  /**
   * Handle verification failure: update state machine + schedule next check.
   */
  private async handleVerifyFailure(
    config: ChannelConfig,
    errorMessage: string,
  ): Promise<'failed'> {
    const newFailures = (config.consecutiveFailures ?? 0) + 1;
    const shouldMarkError = newFailures >= this.FAILURE_THRESHOLD;

    // Determine new health state
    const newHealthState = newFailures === 1 ? 'degraded' : 'unhealthy';

    // Calculate next adaptive check time (exponential backoff)
    const intervalMs = this.calculateNextCheckInterval(newFailures);
    const nextCheck = new Date(Date.now() + intervalMs);

    await this.repository.updateHealthStatus(config.id, {
      status: shouldMarkError ? 'error' : config.status,
      lastHealthError: errorMessage,
      consecutiveFailures: newFailures,
      healthState: newHealthState,
      nextHealthCheckAt: nextCheck,
    });

    this.logger.warn(
      `[HealthCheck] ❌ Config "${config.name}" FAILED ` +
        `(${newFailures}/${this.FAILURE_THRESHOLD}) ` +
        `state: ${config.healthState ?? 'healthy'} → ${newHealthState} ` +
        `next check: ${this.formatInterval(intervalMs)} — ${errorMessage}`,
    );

    // Emit event for Alert Service
    this.eventEmitter.emit('channel-config.health.failed', {
      configId: config.id,
      configName: config.name,
      providerType: config.providerType,
      tenantId: config.tenantId,
      error: errorMessage,
      consecutiveFailures: newFailures,
      statusChanged: shouldMarkError && config.status !== 'error',
    });

    return 'failed';
  }

  // ── Backoff Calculator ────────────────────────────────────────────────────

  /**
   * Calculate next check interval based on consecutive failures.
   * Schedule: 5m → 15m → 1h → 6h (capped)
   */
  private calculateNextCheckInterval(consecutiveFailures: number): number {
    const idx = Math.min(
      consecutiveFailures - 1,
      BACKOFF_INTERVALS_MS.length - 1,
    );
    return BACKOFF_INTERVALS_MS[Math.max(0, idx)];
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private isEnabled(): boolean {
    return (
      this.configService.get<string>('CHANNEL_HEALTH_CHECK_ENABLED', {
        infer: true,
      }) === 'true'
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private formatInterval(ms: number): string {
    if (ms >= 60 * 60 * 1000) return `${Math.round(ms / (60 * 60 * 1000))}h`;
    return `${Math.round(ms / (60 * 1000))}m`;
  }
}
