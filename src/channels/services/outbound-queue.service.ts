import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';

/**
 * Outbound Queue & Throttler Service — Enterprise email sending rate controller.
 *
 * Architecture (from email-integration-plan.md Section 3.1c):
 *   - Per-Second Rate Limit: 1-2 emails/second/tenant to prevent provider bans
 *   - Per-Day Hard Cap: Redis counter tracks daily sends per account
 *   - Bulk Campaign Guard: Blocks campaigns > 500 recipients via personal SMTP
 *
 * Why separate from OutboundService:
 *   - OutboundService handles the actual send logic (nodemailer, CID, etc.)
 *   - This service is the GATE that decides IF and WHEN the send is allowed
 *   - Clean separation of concerns: policy vs mechanism
 *
 * Redis Keys:
 *   outbound:daily:{tenantId}:{configId}:{YYYY-MM-DD}  — daily send counter (TTL: 48h)
 *   outbound:throttle:{tenantId}:{configId}             — sliding window lock (TTL: 1s)
 */

/** Provider daily sending limits (conservative estimates) */
const PROVIDER_DAILY_LIMITS: Record<string, number> = {
  'smtp.gmail.com': 2000, // Google Workspace
  'smtp.office365.com': 10000, // Office 365
  'smtp-mail.outlook.com': 300, // Free Outlook
  default: 2000, // Conservative default
};

/** Threshold for bulk campaign detection */
const BULK_CAMPAIGN_THRESHOLD = 500;

export interface ThrottleCheckResult {
  allowed: boolean;
  reason?: string;
  dailySent?: number;
  dailyLimit?: number;
  retryAfterMs?: number;
}

@Injectable()
export class OutboundQueueService {
  private readonly logger = new Logger(OutboundQueueService.name);

  constructor(private readonly redisService: RedisService) {}

  // ── Pre-Send Gate ──────────────────────────────────────────────────────

  /**
   * Check if a send operation is allowed. Must be called BEFORE dispatching.
   *
   * Three checks in order:
   *   1. Bulk campaign guard (> 500 recipients → BLOCK immediately)
   *   2. Daily quota check (Redis counter)
   *   3. Per-second throttle (sliding window)
   */
  async checkSendAllowed(
    tenantId: string,
    configId: string,
    smtpHost: string,
    recipientCount: number,
  ): Promise<ThrottleCheckResult> {
    // ── Check 1: Bulk Campaign Guard ─────────────────────────────────
    if (recipientCount > BULK_CAMPAIGN_THRESHOLD) {
      this.logger.warn(
        `[OutboundQueue] 🚫 Bulk campaign blocked: tenant=${tenantId}, recipients=${recipientCount}`,
      );
      return {
        allowed: false,
        reason:
          `⚠️ This campaign targets ${recipientCount} recipients, which exceeds the safe daily limit ` +
          `for a personal Gmail/Outlook account. Please use Marketing Email ` +
          `(SendGrid / Amazon SES) for bulk campaigns.`,
      };
    }

    // ── Check 2: Daily Quota ──────────────────────────────────────────
    const dailyLimit = this.getDailyLimit(smtpHost);
    const dailySent = await this.getDailySentCount(tenantId, configId);

    if (dailySent + recipientCount > dailyLimit) {
      this.logger.warn(
        `[OutboundQueue] 🚫 Daily quota exceeded: tenant=${tenantId}, ` +
          `sent=${dailySent}, limit=${dailyLimit}`,
      );
      return {
        allowed: false,
        reason:
          `Daily sending limit reached (${dailySent}/${dailyLimit}). ` +
          `Your email provider resets this limit in approximately ` +
          `${this.hoursUntilMidnight()} hours.`,
        dailySent,
        dailyLimit,
      };
    }

    // ── Check 3: Per-Second Throttle ─────────────────────────────────
    const throttled = await this.isPerSecondThrottled(tenantId, configId);
    if (throttled) {
      return {
        allowed: false,
        reason: 'Sending too fast. Please wait a moment.',
        retryAfterMs: 1000,
        dailySent,
        dailyLimit,
      };
    }

    return { allowed: true, dailySent, dailyLimit };
  }

  // ── Post-Send Recording ───────────────────────────────────────────────

  /**
   * Record a successful send. Must be called AFTER the email is dispatched.
   * Increments the daily counter and sets the per-second throttle.
   */
  async recordSend(
    tenantId: string,
    configId: string,
    recipientCount: number = 1,
  ): Promise<void> {
    const client = this.redisService.getClient();
    const dateKey = this.getDateKey();
    const dailyKey = `outbound:daily:${tenantId}:${configId}:${dateKey}`;
    const throttleKey = `outbound:throttle:${tenantId}:${configId}`;

    // Increment daily counter (TTL: 48h to survive timezone edge cases)
    await client.incrby(dailyKey, recipientCount);
    await client.expire(dailyKey, 48 * 60 * 60);

    // Set per-second throttle (TTL: 1 second)
    await client.set(throttleKey, '1', 'PX', 1000);
  }

  // ── Stats / Monitoring ────────────────────────────────────────────────

  /**
   * Get current daily send stats for a config.
   * Used by Channel Settings UI to show quota usage.
   */
  async getDailyStats(
    tenantId: string,
    configId: string,
    smtpHost: string,
  ): Promise<{ sent: number; limit: number; remaining: number }> {
    const sent = await this.getDailySentCount(tenantId, configId);
    const limit = this.getDailyLimit(smtpHost);
    return {
      sent,
      limit,
      remaining: Math.max(0, limit - sent),
    };
  }

  // ── Private Helpers ───────────────────────────────────────────────────

  private async getDailySentCount(
    tenantId: string,
    configId: string,
  ): Promise<number> {
    const client = this.redisService.getClient();
    const key = `outbound:daily:${tenantId}:${configId}:${this.getDateKey()}`;
    const value = await client.get(key);
    return value ? parseInt(value, 10) : 0;
  }

  private async isPerSecondThrottled(
    tenantId: string,
    configId: string,
  ): Promise<boolean> {
    const client = this.redisService.getClient();
    const key = `outbound:throttle:${tenantId}:${configId}`;
    const exists = await client.exists(key);
    return exists === 1;
  }

  private getDailyLimit(smtpHost: string): number {
    const host = (smtpHost || '').toLowerCase();
    return PROVIDER_DAILY_LIMITS[host] || PROVIDER_DAILY_LIMITS['default'];
  }

  private getDateKey(): string {
    return new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  }

  private hoursUntilMidnight(): number {
    const now = new Date();
    const midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0);
    return Math.ceil((midnight.getTime() - now.getTime()) / (1000 * 60 * 60));
  }
}
