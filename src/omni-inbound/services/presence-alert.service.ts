import { Injectable, Logger } from '@nestjs/common';
import { AgentPresenceService } from './agent-presence.service';
import { CrmSettingsService } from '../../crm-settings/crm-settings.service';
import { RedisService } from '../../redis/redis.service';
import { Server } from 'socket.io';

/**
 * PresenceAlertService — evaluates real-time agent presence data against
 * tenant-configurable thresholds and fires alerts to supervisors.
 *
 * Rules (§4.5 of agent-presence-workforce-spec.md):
 *   1. Invisible Login: AVAILABLE + NOT_ACCEPTING > loginIdleAlertMinutes
 *   2. Over-break: cumulative BREAK time > breakBudgetMinutes
 *   3. Stuck NOT_ACCEPTING: AVAILABLE + NOT_ACCEPTING continuously > stuckNotAcceptingAlertMinutes
 *   4. Long AWAY: AWAY > longAwayAlertMinutes
 *   5. All-FULL: all online agents at capacity + queue not empty
 *
 * Implementation:
 *   - Called by PresenceAlertCron every 60s
 *   - Uses Redis "already alerted" keys (TTL 1h) to prevent notification spam
 *   - Broadcasts alerts via Socket.IO + can be extended with persistent notifications
 */
@Injectable()
export class PresenceAlertService {
  private readonly logger = new Logger(PresenceAlertService.name);

  /** Socket.IO server (injected by gateway after bootstrap). */
  private ioServer: Server | null = null;

  constructor(
    private readonly presenceService: AgentPresenceService,
    private readonly settingsService: CrmSettingsService,
    private readonly redisService: RedisService,
  ) {}

  /** Called by OmniGateway afterInit to wire the Socket.IO server. */
  setServer(server: Server) {
    this.ioServer = server;
  }

  /**
   * Main evaluation loop — call this from the cron.
   * Runs per-tenant (multi-tenant-safe).
   */
  async evaluateAll(tenantId: string): Promise<void> {
    const agents = await this.presenceService.getAllAgents(tenantId);
    if (agents.length === 0) return;

    let cfg: any;
    try {
      cfg = await this.settingsService.getSetting('omni_presence', tenantId);
    } catch {
      return; // No config → skip
    }

    const thresholds: AlertThresholds = {
      loginIdleMinutes: cfg?.loginIdleAlertMinutes ?? 15,
      breakBudgetMinutes: cfg?.breakBudgetMinutes ?? 60,
      stuckNotAcceptingMinutes: cfg?.stuckNotAcceptingAlertMinutes ?? 30,
      longAwayMinutes: cfg?.longAwayAlertMinutes ?? 20,
    };

    const now = Date.now();
    const alerts: AlertPayload[] = [];
    let onlineCount = 0;
    let fullCount = 0;

    for (const agent of agents) {
      if (agent.presenceStatus === 'OFFLINE') continue;
      onlineCount++;
      const presenceMinutes = agent.lastCommandTs
        ? (now - agent.lastCommandTs) / 60_000
        : 0;
      alerts.push(
        ...this.evaluateAgentRules(agent, presenceMinutes, thresholds),
      );
      if (agent.capacityStatus === 'FULL') fullCount++;
    }

    if (onlineCount > 0 && fullCount === onlineCount) {
      alerts.push({
        type: 'all_full',
        agentId: '*',
        detail: `All ${onlineCount} online agents at capacity`,
      });
    }

    for (const alert of alerts) {
      await this.fireAlert(tenantId, alert);
    }

    if (alerts.length > 0) {
      this.logger.debug(
        `[${tenantId}] Evaluated ${agents.length} agents → ${alerts.length} alerts`,
      );
    }
  }

  /**
   * Evaluate all per-agent alert rules and return triggered alerts.
   */
  private evaluateAgentRules(
    agent: any,
    presenceMinutes: number,
    thresholds: AlertThresholds,
  ): AlertPayload[] {
    const alerts: AlertPayload[] = [];

    // Rule 1: Invisible Login
    if (
      agent.presenceStatus === 'AVAILABLE' &&
      agent.routingStatus === 'NOT_ACCEPTING' &&
      presenceMinutes >= thresholds.loginIdleMinutes
    ) {
      alerts.push({
        type: 'invisible_login',
        agentId: agent.userId,
        detail: `AVAILABLE + NOT_ACCEPTING for ${Math.round(presenceMinutes)} min`,
      });
    }

    // Rule 3: Stuck NOT_ACCEPTING (superset of invisible login, longer window)
    if (
      agent.presenceStatus === 'AVAILABLE' &&
      agent.routingStatus === 'NOT_ACCEPTING' &&
      presenceMinutes >= thresholds.stuckNotAcceptingMinutes
    ) {
      alerts.push({
        type: 'stuck_not_accepting',
        agentId: agent.userId,
        detail: `NOT_ACCEPTING for ${Math.round(presenceMinutes)} min`,
      });
    }

    // Rule 4: Long AWAY
    if (
      agent.presenceStatus === 'AWAY' &&
      presenceMinutes >= thresholds.longAwayMinutes
    ) {
      alerts.push({
        type: 'long_away',
        agentId: agent.userId,
        detail: `AWAY for ${Math.round(presenceMinutes)} min`,
      });
    }

    // Rule 2: Over-break (needs daily accumulator from segments)
    const overBreakAlert = this.evaluateOverBreak(
      agent,
      presenceMinutes,
      thresholds.breakBudgetMinutes,
    );
    if (overBreakAlert) alerts.push(overBreakAlert);

    return alerts;
  }

  /**
   * Rule 2: evaluate over-break threshold.
   */
  private evaluateOverBreak(
    agent: any,
    presenceMinutes: number,
    breakBudgetMinutes: number,
  ): AlertPayload | null {
    if (agent.presenceStatus !== 'BREAK') return null;
    const breakToday = (agent as any).breakTodayMinutes ?? 0;
    const totalBreak = breakToday + presenceMinutes;
    if (totalBreak < breakBudgetMinutes) return null;
    return {
      type: 'over_break',
      agentId: agent.userId,
      detail: `BREAK total ${Math.round(totalBreak)} min (budget: ${breakBudgetMinutes})`,
    };
  }

  /**
   * Fire a single alert — deduplicates via Redis key with 1-hour TTL.
   */
  private async fireAlert(
    tenantId: string,
    alert: AlertPayload,
  ): Promise<void> {
    const dedupKey = `presence:alert:${tenantId}:${alert.type}:${alert.agentId}`;

    // Check if already alerted recently (1-hour dedup window)
    const exists = await this.redisService.get(dedupKey);
    if (exists) return;

    // Mark as alerted (TTL 1h)
    await this.redisService.set(dedupKey, '1', 3600);

    // Broadcast to supervisor room
    if (this.ioServer) {
      this.ioServer.to(`tenant:${tenantId}`).emit('presence:alert', {
        type: alert.type,
        agentId: alert.agentId,
        detail: alert.detail,
        timestamp: new Date().toISOString(),
      });
    }

    this.logger.warn(
      `[${tenantId}] Presence alert: ${alert.type} — agent=${alert.agentId} — ${alert.detail}`,
    );
  }
}

interface AlertPayload {
  type:
    | 'invisible_login'
    | 'over_break'
    | 'stuck_not_accepting'
    | 'long_away'
    | 'all_full';
  agentId: string;
  detail: string;
}

interface AlertThresholds {
  loginIdleMinutes: number;
  breakBudgetMinutes: number;
  stuckNotAcceptingMinutes: number;
  longAwayMinutes: number;
}
