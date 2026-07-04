import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AgentPresenceService } from './agent-presence.service';
import { ConversationRepository } from '../repositories/conversation.repository';

/**
 * PresenceReconciliationService — self-healing guard for Redis agent counters.
 *
 * Problem (P0):
 *   The Redis presence hash stores `activeConversations` for each agent.
 *   This counter is incremented/decremented atomically by Lua scripts during
 *   assign/release operations. However, if Redis is flushed, restarted, or a
 *   network partition causes a missed release, the counter drifts permanently.
 *   Drifted counters cause agents to appear "full" with phantom conversations,
 *   silently blocking new assignments until a manual Redis flush.
 *
 * Solution:
 *   1. On-demand reconcile: called whenever an agent reconnects (the most
 *      important case — after a Redis flush + agent reconnect, counters reset).
 *   2. Periodic reconcile: scheduled cron every 5 minutes to self-heal any
 *      drift that accumulated without a reconnect event.
 *
 * Algorithm:
 *   For each agent in the tenant's presence hash:
 *     actual = MongoDB countDocuments(assignedAgentId, status in [open, pending])
 *     if redis.activeConversations !== actual → patch Redis to actual value
 *
 * Performance:
 *   - Uses `countOpenByAgents()` which runs a single aggregation pipeline
 *     for all agents in the tenant (not N individual queries).
 *   - Only writes to Redis when drift is detected (no-op for healthy state).
 *   - Cron is scoped to tenants that have active agents in Redis, not all tenants.
 */
@Injectable()
export class PresenceReconciliationService {
  private readonly logger = new Logger(PresenceReconciliationService.name);

  constructor(
    private readonly presenceService: AgentPresenceService,
    private readonly conversationRepo: ConversationRepository,
  ) {}

  /**
   * Reconcile presence counters for a single agent immediately.
   * Called by the gateway when an agent reconnects.
   *
   * @param tenantId  - tenant owning the agent
   * @param agentId   - the reconnecting agent's user ID
   */
  async reconcileAgent(tenantId: string, agentId: string): Promise<void> {
    try {
      const presence = await this.presenceService.getPresence(
        tenantId,
        agentId,
      );
      if (!presence) return; // agent not in Redis — nothing to reconcile

      const actual = await this.conversationRepo.countOpenByAgent(
        tenantId,
        agentId,
      );
      const stored = presence.activeConversations ?? 0;

      if (stored !== actual) {
        this.logger.warn(
          `Presence drift detected for agent ${agentId} (tenant ${tenantId}): ` +
            `Redis=${stored}, MongoDB=${actual} — patching`,
        );
        await this.presenceService.patchActiveConversations(
          tenantId,
          agentId,
          actual,
        );
      } else {
        this.logger.debug(
          `Agent ${agentId} presence counter OK (activeConversations=${actual})`,
        );
      }
    } catch (err: any) {
      this.logger.error(
        `Failed to reconcile presence for agent ${agentId}: ${err.message}`,
      );
    }
  }

  /**
   * Reconcile presence counters for ALL agents in a tenant.
   * Called by the periodic cron or manually by ops tooling.
   *
   * @param tenantId - tenant to reconcile
   * @returns number of agents whose counters were patched
   */
  async reconcileTenant(tenantId: string): Promise<number> {
    const allAgents = await this.presenceService.getAllAgents(tenantId);
    if (allAgents.length === 0) return 0;

    const agentIds = allAgents.map((a) => a.userId);

    // Batch aggregation — single MongoDB round-trip for all agents
    const actualCounts = await this.conversationRepo.countOpenByAgents(
      tenantId,
      agentIds,
    );

    let patchedCount = 0;
    const patches: Promise<void>[] = [];

    for (const presence of allAgents) {
      const actual = actualCounts.get(presence.userId) ?? 0;
      const stored = presence.activeConversations ?? 0;

      if (stored !== actual) {
        this.logger.warn(
          `[Reconcile] Agent ${presence.userId} drift: Redis=${stored}, MongoDB=${actual}`,
        );
        patches.push(
          this.presenceService
            .patchActiveConversations(tenantId, presence.userId, actual)
            .catch((err: any) =>
              this.logger.error(
                `Failed to patch agent ${presence.userId}: ${err.message}`,
              ),
            ),
        );
        patchedCount++;
      }
    }

    if (patches.length > 0) {
      await Promise.allSettled(patches);
      this.logger.log(
        `[Reconcile] Tenant ${tenantId}: patched ${patchedCount}/${allAgents.length} agents`,
      );
    } else {
      this.logger.debug(
        `[Reconcile] Tenant ${tenantId}: all ${allAgents.length} agents OK`,
      );
    }

    return patchedCount;
  }

  /**
   * Periodic cron: reconcile all tenants with active agents in Redis.
   * Runs every 5 minutes. Detects drift that accumulates without reconnect events.
   *
   * Scope: only tenants that have at least one active agent in the Redis
   * presence hash. Tenants with no agents are skipped.
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async reconcileAllTenants(): Promise<void> {
    this.logger.debug(
      '[Reconcile] Starting periodic presence reconciliation...',
    );
    try {
      const tenantIds =
        await this.conversationRepo.findDistinctTenantIdsWithActiveConversations();

      if (tenantIds.length === 0) {
        this.logger.debug('[Reconcile] No active tenants found');
        return;
      }

      let totalPatched = 0;
      for (const tenantId of tenantIds) {
        try {
          const patched = await this.reconcileTenant(tenantId);
          totalPatched += patched;
        } catch (err: any) {
          this.logger.error(
            `[Reconcile] Failed for tenant ${tenantId}: ${err.message}`,
          );
        }
      }

      this.logger.log(
        `[Reconcile] Completed. Tenants scanned: ${tenantIds.length}, agents patched: ${totalPatched}`,
      );
    } catch (err: any) {
      this.logger.error(`[Reconcile] Cron failed: ${err.message}`, err.stack);
    }
  }
}
