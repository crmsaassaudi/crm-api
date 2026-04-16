import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AgentStatusAuditRepository } from '../repositories/agent-status-audit.repository';
import { AgentPresenceService } from './agent-presence.service';
import { UsersService } from '../../users/users.service';
import {
  AgentIntentStatus,
  StatusTransitionTrigger,
  AgentPresence,
} from '../domain/agent-presence';

/**
 * Work time summary for a single agent on a single day.
 */
export interface AgentWorkTimeSummary {
  agentId: string;
  agentName: string;
  agentEmail: string;
  date: string; // YYYY-MM-DD
  /** Time spent in 'available' status (ms) */
  availableDurationMs: number;
  /** Time spent in 'busy' status (ms) */
  busyDurationMs: number;
  /** Time spent in 'away' status (ms) */
  awayDurationMs: number;
  /** Time spent in 'offline' status (ms) */
  offlineDurationMs: number;
  /** Total online time: available + busy + away (ms) */
  totalOnlineDurationMs: number;
  /** Number of status transitions during the day */
  transitionCount: number;
  /** Raw transitions for drill-down */
  transitions: Array<{
    fromStatus: string;
    toStatus: string;
    trigger: string;
    timestamp: string;
  }>;
}

/**
 * AgentStatusAuditService — logs intentStatus transitions and computes
 * daily work time reports for agent KPI tracking.
 */
@Injectable()
export class AgentStatusAuditService implements OnModuleInit {
  private readonly logger = new Logger(AgentStatusAuditService.name);

  constructor(
    private readonly auditRepo: AgentStatusAuditRepository,
    private readonly presenceService: AgentPresenceService,
    private readonly usersService: UsersService,
  ) {}

  /**
   * Register the audit callback on the presence service during module init.
   */
  onModuleInit() {
    this.presenceService.setStatusTransitionCallback(
      this.logTransition.bind(this),
    );
    this.logger.log('Registered status transition callback for audit logging');
  }

  /**
   * Log a status transition to the audit log.
   */
  async logTransition(
    tenantId: string,
    agentId: string,
    fromStatus: AgentIntentStatus,
    toStatus: AgentIntentStatus,
    trigger: StatusTransitionTrigger,
    metadata?: Record<string, any>,
  ): Promise<void> {
    try {
      await this.auditRepo.create({
        tenantId,
        agentId,
        fromStatus,
        toStatus,
        trigger,
        timestamp: new Date(),
        metadata,
      });
      this.logger.debug(
        `Audit: Agent ${agentId} ${fromStatus} → ${toStatus} (${trigger})`,
      );
    } catch (err) {
      this.logger.error(`Failed to log status transition: ${err.message}`);
    }
  }

  /**
   * Compute work time summary for all agents in a tenant on a given date.
   */
  async getTeamWorkTimeSummary(
    tenantId: string,
    date: string,
  ): Promise<AgentWorkTimeSummary[]> {
    const { startOfDay, endOfDay, capEnd } = this.parseDateRange(date);

    // 1. Get all logs for the tenant and date range
    const allLogs = await this.auditRepo.findByTenantAndDateRange(
      tenantId,
      startOfDay,
      endOfDay,
    );

    // Group logs by agentId
    const groupedLogs = new Map<string, typeof allLogs>();
    for (const log of allLogs) {
      const agentId = log.agentId;
      if (!groupedLogs.has(agentId)) {
        groupedLogs.set(agentId, []);
      }
      groupedLogs.get(agentId)!.push(log);
    }

    // 2. Get all agents currently active in the tenant's presence store
    const activeAgents = await this.presenceService.getAllAgents(tenantId);
    const activeAgentsMap = new Map<string, AgentPresence>();
    activeAgents.forEach((a) => activeAgentsMap.set(a.userId, a));

    // Merge ID sets: agents with logs + agents currently online
    const allAgentIds = new Set<string>();
    groupedLogs.forEach((_, id) => allAgentIds.add(id));
    activeAgents.forEach((a) => allAgentIds.add(a.userId));

    // 3. Fetch agent metadata (name, email)
    const agentIdsArray = Array.from(allAgentIds);
    const users = await this.usersService.findByIdsGlobal(agentIdsArray);
    const userMap = new Map<string, { name: string; email: string }>();
    users.forEach((u) => {
      userMap.set(u.id.toString(), {
        name:
          `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim() || 'Unknown Agent',
        email: u.email ?? 'no-email',
      });
    });

    const isToday = new Date().toISOString().slice(0, 10) === date;

    const summaries: AgentWorkTimeSummary[] = [];
    for (const agentId of allAgentIds) {
      const logs = groupedLogs.get(agentId) || [];
      const user = userMap.get(agentId) || {
        name: 'Unknown Agent',
        email: 'no-email',
      };
      const currentPresence = activeAgentsMap.get(agentId);

      summaries.push(
        this.computeWorkTime(
          agentId,
          user.name,
          user.email,
          date,
          logs,
          startOfDay,
          capEnd,
          isToday ? currentPresence : undefined,
        ),
      );
    }

    this.logger.debug(
      `Computed team summary for tenant ${tenantId} on ${date}: ${summaries.length} agents found`,
    );

    return summaries;
  }

  /**
   * Compute work time summary for a single agent on a given date.
   */
  async getAgentWorkTimeSummary(
    tenantId: string,
    agentId: string,
    date: string,
  ): Promise<AgentWorkTimeSummary> {
    const { startOfDay, endOfDay, capEnd } = this.parseDateRange(date);

    // 1. Get logs for the single agent
    const logs = await this.auditRepo.findByAgentAndDateRange(
      tenantId,
      agentId,
      startOfDay,
      endOfDay,
    );

    // 2. Fetch agent metadata
    const user = await this.usersService.findById(agentId);
    const name = user
      ? `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim()
      : 'Unknown Agent';
    const email = user?.email ?? 'no-email';

    // 3. Get current presence (if today)
    const isToday = new Date().toISOString().slice(0, 10) === date;
    const currentPresence = isToday
      ? await this.presenceService.getPresence(tenantId, agentId)
      : null;

    return this.computeWorkTime(
      agentId,
      name || 'Unknown Agent',
      email,
      date,
      logs,
      startOfDay,
      capEnd,
      currentPresence || undefined,
    );
  }

  // ─── Internal Helpers ───────────────────────────────────────────────

  private parseDateRange(date: string): {
    startOfDay: Date;
    endOfDay: Date;
    capEnd: Date;
  } {
    const startOfDay = new Date(`${date}T00:00:00.000Z`);
    const endOfDay = new Date(`${date}T23:59:59.999Z`);
    const now = new Date();
    // If the requested date is today, cap at "now"; otherwise end of day
    const capEnd = now < endOfDay ? now : endOfDay;

    return { startOfDay, endOfDay, capEnd };
  }

  /**
   * Core work time computation from a sorted list of transitions.
   */
  private computeWorkTime(
    agentId: string,
    agentName: string,
    agentEmail: string,
    date: string,
    logs: Array<{
      fromStatus: string;
      toStatus: string;
      trigger: string;
      timestamp: Date;
    }>,
    startOfDay: Date,
    capEnd: Date,
    currentPresence?: AgentPresence,
  ): AgentWorkTimeSummary {
    const durations: Record<string, number> = {
      available: 0,
      busy: 0,
      away: 0,
      offline: 0,
    };

    if (logs.length === 0) {
      // No transitions logged today.
      if (currentPresence && currentPresence.intentStatus !== 'offline') {
        // Fallback Heuristic: If agent is online NOW but has 0 logs today,
        // assume they've been in their current intentStatus since start of day.
        // This handles agents who were already online when audit system started.
        const status = currentPresence.intentStatus;
        const duration = capEnd.getTime() - startOfDay.getTime();
        if (status in durations) {
          durations[status] = duration;
        } else {
          durations.offline = duration;
        }
      } else {
        // No logs and not currently online → agent was offline all day
        durations.offline = capEnd.getTime() - startOfDay.getTime();
      }
    } else {
      // Time from start of day to first transition = offline (usually)
      const firstTs = new Date(logs[0].timestamp).getTime();
      const dayStart = startOfDay.getTime();
      if (firstTs > dayStart) {
        durations.offline += firstTs - dayStart;
      }

      // Process transitions
      for (let i = 0; i < logs.length; i++) {
        const current = logs[i];
        const currentTs = new Date(current.timestamp).getTime();
        const nextTs =
          i + 1 < logs.length
            ? new Date(logs[i + 1].timestamp).getTime()
            : capEnd.getTime();

        const duration = Math.max(0, nextTs - currentTs);
        const status = current.toStatus;

        if (status in durations) {
          durations[status] += duration;
        }
      }
    }

    return {
      agentId,
      agentName,
      agentEmail,
      date,
      availableDurationMs: durations.available,
      busyDurationMs: durations.busy,
      awayDurationMs: durations.away,
      offlineDurationMs: durations.offline,
      totalOnlineDurationMs:
        durations.available + durations.busy + durations.away,
      transitionCount: logs.length,
      transitions: logs.map((l) => ({
        fromStatus: l.fromStatus,
        toStatus: l.toStatus,
        trigger: l.trigger,
        timestamp: new Date(l.timestamp).toISOString(),
      })),
    };
  }
}
