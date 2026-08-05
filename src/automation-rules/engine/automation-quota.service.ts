import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { IOREDIS_CLIENT } from '../../redis/redis.tokens';
import { AutomationMetricsService } from '../observability/automation-metrics.service';

/** What a quota is counted against. */
export type QuotaKind =
  | 'execution_daily'
  | 'email_daily'
  | 'sms_daily'
  | 'email_rate'
  | 'sms_rate';

export interface QuotaDecision {
  allowed: boolean;
  /** Human-readable reason, safe to surface in an execution log. */
  reason?: string;
  /** Which limit was hit. */
  kind?: QuotaKind;
  /** True when waiting will help (a per-minute rate rather than a daily cap). */
  transient?: boolean;
}

const ALLOWED: QuotaDecision = { allowed: true };

/**
 * Atomic incr-with-TTL. A plain INCR followed by a conditional EXPIRE has a race
 * where two workers both see count > 1 and neither sets the TTL, leaking the key
 * forever — which for a daily counter means the tenant is blocked permanently.
 */
const INCR_WITH_TTL = `
  local count = redis.call('incr', KEYS[1])
  if count == 1 then
    redis.call('expire', KEYS[1], ARGV[1])
  end
  return count
`;

function envInt(name: string, fallback: number): number {
  const parsed = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * Per-tenant spend and throughput limits for the automation engine.
 *
 * Two ceilings, both per tenant because that is the unit with a contract: a daily
 * cost cap (executions, emails, SMS — providers bill per message) and a
 * per-minute rate that keeps one tenant's burst out of everyone else's queue.
 *
 * Fail closed: a Redis error refuses the work. A quota that fails open is not a
 * quota, and for money and other tenants' latency, "allow everything while the
 * counter is down" is the expensive direction. Same stance as
 * ActionIdempotencyService at the side-effect boundary.
 */
@Injectable()
export class AutomationQuotaService {
  private readonly logger = new Logger(AutomationQuotaService.name);

  constructor(
    @Inject(IOREDIS_CLIENT) private readonly redis: Redis,
    private readonly metrics: AutomationMetricsService,
  ) {}

  /** 0 disables a limit — an explicit choice, distinct from "unset". */
  private get limits(): Record<QuotaKind, number> {
    return {
      execution_daily: envInt('AUTOMATION_TENANT_EXECUTIONS_PER_DAY', 100_000),
      email_daily: envInt('AUTOMATION_TENANT_EMAILS_PER_DAY', 20_000),
      sms_daily: envInt('AUTOMATION_TENANT_SMS_PER_DAY', 2_000),
      email_rate: envInt('AUTOMATION_TENANT_EMAILS_PER_MINUTE', 500),
      sms_rate: envInt('AUTOMATION_TENANT_SMS_PER_MINUTE', 60),
    };
  }

  /** Charge one workflow execution against the tenant's daily allowance. */
  consumeExecution(tenantId: string): Promise<QuotaDecision> {
    return this.consume(tenantId, 'execution_daily');
  }

  /**
   * Charge one outbound message. Checks the per-minute rate first so a tenant
   * that is merely bursting gets a retryable answer rather than burning a day's
   * allowance on messages that will be throttled anyway.
   */
  async consumeMessage(
    tenantId: string,
    channel: 'email' | 'sms',
  ): Promise<QuotaDecision> {
    const rate = await this.consume(
      tenantId,
      channel === 'email' ? 'email_rate' : 'sms_rate',
    );
    if (!rate.allowed) return rate;

    return this.consume(
      tenantId,
      channel === 'email' ? 'email_daily' : 'sms_daily',
    );
  }

  private async consume(
    tenantId: string,
    kind: QuotaKind,
  ): Promise<QuotaDecision> {
    const limit = this.limits[kind];
    if (limit === 0) return ALLOWED;

    const transient = kind.endsWith('_rate');
    const windowSeconds = transient ? 60 : 86_400;
    const key = `automation:quota:${kind}:${tenantId}:${this.windowStamp(transient)}`;

    let used: number;
    try {
      used = (await this.redis.eval(
        INCR_WITH_TTL,
        1,
        key,
        String(windowSeconds),
      )) as number;
    } catch (error: any) {
      this.logger.error(
        `[Quota] Redis error checking ${kind} for tenant ${tenantId} — ` +
          `refusing the work rather than spending without a counter: ${error.message}`,
      );
      return {
        allowed: false,
        transient: true,
        kind,
        reason:
          'QUOTA_UNAVAILABLE: cannot verify the tenant automation quota, so the ' +
          'action was not performed.',
      };
    }

    if (used <= limit) return ALLOWED;

    this.metrics.recordQuotaRejection(kind, tenantId);
    if (used === limit + 1) {
      // Log once on the crossing rather than per rejected item.
      this.logger.warn(
        `[Quota] Tenant ${tenantId} reached its ${kind} limit of ${limit}`,
      );
    }

    return {
      allowed: false,
      kind,
      transient,
      reason: transient
        ? `QUOTA_RATE_EXCEEDED: tenant exceeded ${limit} ${kind.replace('_rate', '')} per minute`
        : `QUOTA_DAILY_EXCEEDED: tenant exceeded ${limit} ${kind.replace('_daily', '')} per day`,
    };
  }

  /**
   * Window identity.
   *
   * A UTC date for daily counters and a minute bucket for rate counters, so the
   * key rolls over deterministically instead of depending on when the first
   * request of the window happened to land.
   */
  private windowStamp(transient: boolean): string {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    if (!transient) return day;
    return `${day}T${String(now.getUTCHours()).padStart(2, '0')}${String(
      now.getUTCMinutes(),
    ).padStart(2, '0')}`;
  }
}
