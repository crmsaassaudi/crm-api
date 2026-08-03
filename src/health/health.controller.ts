import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { Public } from 'nest-keycloak-connect';
import { RedisService } from '../redis/redis.service';
import { ResilienceMetricsService } from '../common/http/resilience-metrics.service';
import { ConfigService } from '@nestjs/config';
import { AllConfigType } from '../config/config.type';
import { OpenSearchEngine } from '../search/engines/opensearch.engine';
import {
  SEARCH_CAPABILITY_NAMES,
  capabilityDefinition,
  resolveCapability,
} from '../search/capabilities/search-capabilities';
import { MetricsService } from '../observability/metrics.service';

type ComponentStatus = 'ok' | 'degraded' | 'down';

interface ComponentReport {
  status: ComponentStatus;
  latencyMs?: number;
  detail?: string;
}

/**
 * Health Check controller.
 *
 * - `GET /health` — fast liveness probe, doesn't touch dependencies. Used
 *   by k8s livenessProbe so a slow Mongo/Redis doesn't trigger pod kill.
 * - `GET /health/ready` — readiness probe, pings Mongo + Redis. Pod is
 *   removed from the service when this returns 503.
 * - `GET /health/deep` — operator-facing, includes per-dependency latency.
 */
@Controller({ path: 'health', version: '1' })
@Public()
export class HealthController {
  private readonly startedAt = new Date();

  constructor(
    @Optional() @InjectConnection() private readonly mongo?: Connection,
    @Optional() private readonly redisService?: RedisService,
    @Optional()
    private readonly resilienceMetrics?: ResilienceMetricsService,
    @Optional() private readonly configService?: ConfigService<AllConfigType>,
    @Optional() private readonly openSearch?: OpenSearchEngine,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  check() {
    return {
      status: 'ok',
      uptime: Math.floor((Date.now() - this.startedAt.getTime()) / 1000),
      timestamp: new Date().toISOString(),
    };
  }

  @Get('ready')
  async ready() {
    const report = await this.collect();
    let overall: ComponentStatus = 'ok';
    if (Object.values(report).some((c) => c.status === 'down')) {
      overall = 'down';
    } else if (Object.values(report).some((c) => c.status === 'degraded')) {
      overall = 'degraded';
    }

    if (overall === 'down') {
      throw new ServiceUnavailableException({
        status: 'down',
        components: report,
      });
    }
    return { status: overall, components: report };
  }

  @Get('deep')
  async deep() {
    const report = await this.collect({ includeFreshness: true });
    return {
      status: Object.values(report).every((c) => c.status === 'ok')
        ? 'ok'
        : 'degraded',
      uptime: Math.floor((Date.now() - this.startedAt.getTime()) / 1000),
      timestamp: new Date().toISOString(),
      components: report,
      searchCapabilities: this.searchCapabilities(),
    };
  }

  /**
   * Which engine currently answers each search capability, and why.
   *
   * Exists so that "why is this tenant not finding anything" is answerable with
   * one request instead of by reading three configuration sources — the kill
   * switch, the per-capability overrides, and the registry defaults — and
   * guessing how they combined.
   */
  private searchCapabilities() {
    const config = this.configService?.get('opensearch', { infer: true });
    const runtime = {
      openSearchEnabled: config?.enabled ?? false,
      overrides: config?.capabilityOverrides ?? {},
    };
    return Object.fromEntries(
      SEARCH_CAPABILITY_NAMES.map((name) => {
        const definition = capabilityDefinition(name);
        const plan = resolveCapability(name, runtime);
        return [
          name,
          {
            tier: definition.tier,
            owner: definition.owner,
            servedBy: plan.disabled ? 'disabled' : plan.engine,
            ...(plan.divertedByConfig ? { divertedByConfig: true } : {}),
            ...(plan.reason ? { reason: plan.reason } : {}),
          },
        ];
      }),
    );
  }

  private async collect(
    options: { includeFreshness: boolean } = { includeFreshness: false },
  ): Promise<Record<string, ComponentReport>> {
    const [mongo, redis, opensearch] = await Promise.all([
      this.checkMongo(),
      this.checkRedis(),
      this.checkOpenSearch(options.includeFreshness),
    ]);
    return {
      mongo,
      redis,
      ...(opensearch ? { opensearch } : {}),
    };
  }

  /**
   * OpenSearch is never reported as `down`.
   *
   * `ready()` turns `down` into a 503, which withdraws every pod of the API
   * from the load balancer. Losing OpenSearch costs some capabilities their
   * quality and switches others off — see `searchCapabilities()` for which —
   * but it never costs the product its ability to serve, so it must not be able
   * to take the whole application offline.
   */
  private async checkOpenSearch(
    includeFreshness: boolean,
  ): Promise<ComponentReport | null> {
    const enabled =
      this.configService?.get('opensearch', { infer: true })?.enabled ?? false;
    if (!enabled) return null;
    if (!this.openSearch) {
      return { status: 'degraded', detail: 'no service' };
    }
    try {
      const latencyMs = await this.openSearch.ping();
      // The freshness aggregate scans the whole index. On the readiness path
      // that is one such scan per pod every few seconds, so it belongs to the
      // operator-facing probe only.
      const newestRecordAgeSeconds = includeFreshness
        ? await this.openSearch.newestRecordAgeSeconds()
        : null;
      if (newestRecordAgeSeconds !== null) {
        this.metrics?.setGauge(
          'crm_search_newest_record_age_seconds',
          { engine: 'opensearch' },
          newestRecordAgeSeconds,
        );
      }
      return {
        status: 'ok',
        latencyMs,
        ...(newestRecordAgeSeconds !== null
          ? { detail: `newestRecordAgeSeconds=${newestRecordAgeSeconds}` }
          : {}),
      };
    } catch {
      return { status: 'degraded', detail: 'ping failed; search uses MongoDB' };
    }
  }

  private async checkMongo(): Promise<ComponentReport> {
    if (!this.mongo) return { status: 'down', detail: 'no connection' };
    const t0 = Date.now();
    try {
      const db = this.mongo.db;
      if (!db) return { status: 'down', detail: 'db handle missing' };
      // ping is cheap and exercises actual driver round-trip.
      await db.admin().ping();
      return { status: 'ok', latencyMs: Date.now() - t0 };
    } catch (err: any) {
      return {
        status: 'down',
        latencyMs: Date.now() - t0,
        detail: err?.message ?? 'ping failed',
      };
    }
  }

  private async checkRedis(): Promise<ComponentReport> {
    if (!this.redisService) return { status: 'down', detail: 'no service' };
    const t0 = Date.now();
    try {
      const client = this.redisService.getClient();
      const reply = await client.ping();
      const latencyMs = Date.now() - t0;
      if (reply !== 'PONG') {
        return { status: 'degraded', latencyMs, detail: `reply=${reply}` };
      }
      return { status: 'ok', latencyMs };
    } catch (err: any) {
      return {
        status: 'down',
        latencyMs: Date.now() - t0,
        detail: err?.message ?? 'ping failed',
      };
    }
  }

  // Queue backlog metrics

  /** Critical queue names to monitor. */
  private static readonly MONITORED_QUEUES = [
    // Omni-channel inbound pipeline
    'omni-webhooks',
    'omni-routing',
    'omni-media-cache',
    'omni-sticky-retry',
    'omni-auto-resolve',
    'omni-fallback',
    'bot-processing',
    // Automation engine
    'automation-actions',
    'automation-actions-email',
    'automation-actions-sms',
    'automation-actions-internal',
    'automation-actions-webhook',
    'automation-actions-dlq',
    'automation-triggers',
    'automation-actions-bulk',
    'automation-delayed-resume',
    // System
    'crm-dlq',
  ];

  /**
   * `GET /health/queues` — report backlog sizes for all critical BullMQ queues.
   *
   * Uses raw Redis commands against BullMQ's internal key structure:
   *   - `bull:<name>:wait` (list)  → waiting jobs
   *   - `bull:<name>:active` (list) → in-progress jobs
   *   - `bull:<name>:delayed` (sorted set) → scheduled jobs
   *   - `bull:<name>:failed` (sorted set) → failed jobs
   */
  @Get('queues')
  async queues() {
    if (!this.redisService) {
      throw new ServiceUnavailableException('Redis not available');
    }

    const client = this.redisService.getClient();
    const prefix = 'bull';
    const results: Record<
      string,
      { waiting: number; active: number; delayed: number; failed: number }
    > = {};

    await Promise.all(
      HealthController.MONITORED_QUEUES.map(async (name) => {
        const [waiting, active, delayed, failed] = await Promise.all([
          client.llen(`${prefix}:${name}:wait`),
          client.llen(`${prefix}:${name}:active`),
          client.zcard(`${prefix}:${name}:delayed`),
          client.zcard(`${prefix}:${name}:failed`),
        ]);
        results[name] = { waiting, active, delayed, failed };
      }),
    );

    const totalWaiting = Object.values(results).reduce(
      (sum, q) => sum + q.waiting,
      0,
    );
    const totalFailed = Object.values(results).reduce(
      (sum, q) => sum + q.failed,
      0,
    );

    return {
      status: totalFailed > 100 ? 'degraded' : 'ok',
      totalWaiting,
      totalFailed,
      queues: results,
    };
  }

  /**
   * Durable automation hand-off health. A healthy Redis ping is insufficient:
   * events can still be accumulating in Mongo because workers are absent,
   * queue publication is failing, or a poison event exhausted its retries.
   */
  @Get('automation-outbox')
  async automationOutbox() {
    if (!this.mongo?.db) {
      throw new ServiceUnavailableException('MongoDB not available');
    }

    const collection = this.mongo.db.collection('automation_outbox_events');
    const [pending, publishing, failed, oldest] = await Promise.all([
      collection.countDocuments({ status: 'pending' }),
      collection.countDocuments({ status: 'publishing' }),
      collection.countDocuments({ status: 'failed' }),
      collection.findOne(
        { status: { $in: ['pending', 'publishing'] } },
        { sort: { createdAt: 1 }, projection: { createdAt: 1, eventId: 1 } },
      ),
    ]);

    const oldestAgeSeconds = oldest?.createdAt
      ? Math.floor((Date.now() - new Date(oldest.createdAt).getTime()) / 1000)
      : 0;
    const status =
      failed > 0 || oldestAgeSeconds > 60 ? 'degraded' : ('ok' as const);

    return {
      status,
      pending,
      publishing,
      failed,
      oldestAgeSeconds,
      oldestEventId: oldest?.eventId ?? null,
    };
  }

  // Channel adapter health check

  /** Channel adapters to report on. */
  private static readonly CHANNEL_ADAPTERS = [
    'facebook',
    'instagram',
    'whatsapp',
    'zalo',
    'telegram',
    'tiktok',
    'bot',
  ] as const;

  /**
   * `GET /health/channels` — report resilience metrics per channel adapter.
   *
   * Returns error rate, total calls, and last error for each adapter.
   * Ops can use this to detect degraded channel connectivity.
   */
  @Get('channels')
  channels() {
    if (!this.resilienceMetrics) {
      return {
        status: 'unknown',
        detail: 'ResilienceMetricsService not available',
      };
    }

    const allMetrics = this.resilienceMetrics.getMetrics();
    const channels: Record<string, any> = {};
    let hasError = false;

    for (const adapter of HealthController.CHANNEL_ADAPTERS) {
      const metric = allMetrics[adapter];
      const report = this.buildChannelReport(metric);
      channels[adapter] = report;
      if (report.status === 'degraded') hasError = true;
    }

    return {
      status: hasError ? 'degraded' : 'ok',
      channels,
    };
  }

  /** Build a single channel adapter health report from its resilience metric. */
  private buildChannelReport(metric: any): Record<string, any> {
    if (!metric) {
      return {
        status: 'no_data',
        detail: 'No API calls recorded since process start',
      };
    }

    const errorRate =
      metric.total > 0 ? (metric.failure / metric.total) * 100 : 0;
    return {
      status: errorRate > 50 ? 'degraded' : 'ok',
      total: metric.total,
      success: metric.success,
      failure: metric.failure,
      errorRate: `${errorRate.toFixed(2)}%`,
      lastError: metric.lastError ?? null,
      lastUpdated: metric.lastUpdated ?? null,
    };
  }
}
