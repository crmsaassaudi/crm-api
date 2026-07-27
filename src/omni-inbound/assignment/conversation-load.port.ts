import { Injectable } from '@nestjs/common';
import { AssignmentScope, LoadPort } from '../../assignment/core/ports';
import { AssignmentStrategy } from '../../assignment/domain/assignment.types';
import { AgentPresenceService } from '../services/agent-presence.service';
import { RoundRobinCursorService } from '../../assignment/infrastructure/reservation/round-robin-cursor.service';

/**
 * Load and reservation for conversations, backed by the presence layer.
 *
 * The counter lives in the presence hash next to heartbeat and per-agent
 * capacity, and its Lua scripts additionally verify the heartbeat is fresh — so
 * a reservation cannot land on an agent whose connection has gone stale. That is
 * behaviour the generic ZSET service cannot provide, which is why this is a
 * separate LoadPort rather than a shared one.
 *
 * The round-robin cursor, by contrast, IS shared: rotation has nothing to do
 * with presence, and having two implementations of it was one of the
 * duplications this consolidation removes.
 */
@Injectable()
export class ConversationLoadPort implements LoadPort {
  constructor(
    private readonly presence: AgentPresenceService,
    private readonly cursor: RoundRobinCursorService,
  ) {}

  /** Rotation is fair within a team, on a per-channel basis. */
  private cursorScope(scope: AssignmentScope): string {
    return `${scope.tenantId}:Conversation:${scope.scopeId ?? '-'}:${
      scope.groupId ?? '-'
    }`;
  }

  async loads(
    scope: AssignmentScope,
    candidateIds: string[],
  ): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    await Promise.all(
      candidateIds.map(async (id) => {
        const presence = await this.presence.getPresence(scope.tenantId, id);
        result.set(id, presence?.activeConversations ?? 0);
      }),
    );
    return result;
  }

  async rotate(
    scope: AssignmentScope,
    candidateIds: string[],
  ): Promise<string[]> {
    return this.cursor.rotate(this.cursorScope(scope), candidateIds);
  }

  async reserve(
    scope: AssignmentScope,
    orderedCandidateIds: string[],
    strategy: AssignmentStrategy,
    maxCapacity: number,
  ): Promise<string | null> {
    if (orderedCandidateIds.length === 0) return null;

    let reserved: string | null;
    switch (strategy) {
      case 'round-robin':
        // First-fit over the rotated order: one Lua call walks the list and
        // atomically reserves the first agent with a free slot, so rotation is
        // preserved instead of collapsing into least-busy.
        reserved = await this.presence.reserveFirstEligibleAgent(
          scope.tenantId,
          orderedCandidateIds,
        );
        break;
      case 'capacity-based':
        reserved = await this.presence.reserveCapacityBasedAgent(
          scope.tenantId,
          orderedCandidateIds,
          maxCapacity,
        );
        break;
      case 'least-busy':
      default:
        reserved = await this.presence.reserveAgentFromCandidates(
          scope.tenantId,
          orderedCandidateIds,
        );
        break;
    }

    if (reserved) await this.cursor.advance(this.cursorScope(scope), reserved);
    return reserved;
  }

  /**
   * Who would be picked, reserving nothing.
   *
   * Resolves capacity the same way the Lua scripts do — per-agent
   * `maxCapacity` from presence, falling back to the scope default — so a dry
   * run cannot claim an agent who is over their personal limit but under the
   * tenant one.
   */
  async preview(
    scope: AssignmentScope,
    orderedCandidateIds: string[],
    strategy: AssignmentStrategy,
    maxCapacity: number,
  ): Promise<string | null> {
    if (orderedCandidateIds.length === 0) return null;

    const rows = await Promise.all(
      orderedCandidateIds.map(async (id) => {
        const presence = await this.presence.getPresence(scope.tenantId, id);
        return {
          id,
          load: presence?.activeConversations ?? 0,
          capacity:
            presence?.maxCapacity && presence.maxCapacity > 0
              ? presence.maxCapacity
              : maxCapacity,
          // An agent with no presence record cannot be reserved by the scripts,
          // which skip members missing from the presence hash.
          present: presence != null,
        };
      }),
    );

    const eligible = rows.filter(
      (r) => r.present && (strategy === 'least-busy' || r.load < r.capacity),
    );
    if (eligible.length === 0) return null;

    // round-robin takes the first eligible entry of the rotated order; the
    // load-ordered strategies take the lowest load.
    if (strategy === 'round-robin') return eligible[0].id;
    return eligible.reduce((best, r) => (r.load < best.load ? r : best)).id;
  }

  async release(scope: AssignmentScope, candidateId: string): Promise<void> {
    await this.presence.releaseConversation(scope.tenantId, candidateId);
  }
}
