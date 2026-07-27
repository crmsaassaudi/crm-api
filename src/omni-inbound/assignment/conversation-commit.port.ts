import { Injectable, Logger } from '@nestjs/common';
import { AssignmentScope, CommitPort } from '../../assignment/core/ports';
import { ConversationRepository } from '../repositories/conversation.repository';

/**
 * Persisting a conversation assignment.
 *
 * `assignedAgentId` and `assignedGroupId` are written together, in one update.
 * Writing only the agent is what left the group-visibility branch of
 * `applyVisibilityScope` effectively dead: a routing rule's team was used to
 * pick an agent and then thrown away, so a team lead could not see their own
 * team's conversations until an agent happened to be assigned.
 */
@Injectable()
export class ConversationCommitPort implements CommitPort {
  private readonly logger = new Logger(ConversationCommitPort.name);

  constructor(private readonly conversationRepo: ConversationRepository) {}

  async commit(
    scope: AssignmentScope,
    assigneeId: string,
    groupId: string | null,
  ): Promise<boolean> {
    if (!scope.entityId) return false;

    // Conditional write: only claim a conversation that is still unassigned.
    // Returns null when someone else got there first, which the core reads as a
    // lost race and rolls the reservation back.
    const committed = await this.conversationRepo.assignIfUnassigned(
      scope.entityId,
      assigneeId,
      groupId,
    );
    return committed !== null;
  }

  /**
   * Conditional write for explicit reassignment: only commits when the
   * conversation's current assignee still equals `expectedPreviousAgentId`
   * (the value the caller observed before deciding to reassign). Returns
   * false — a lost race, same contract as `commit()` — when it has since
   * changed, so the core releases the reservation instead of leaking it.
   */
  async reassign(
    scope: AssignmentScope,
    assigneeId: string,
    groupId: string | null,
    expectedPreviousAgentId: string | null,
  ): Promise<boolean> {
    if (!scope.entityId) return false;
    const committed = await this.conversationRepo.reassignIfExpected(
      scope.entityId,
      assigneeId,
      groupId,
      expectedPreviousAgentId,
    );
    return committed !== null;
  }

  /**
   * Park the conversation in its team's queue when there is no agent, so the
   * team can still see and claim it. Best-effort: failing to tag a queue must
   * not turn a `queued` outcome into a thrown error on the inbound hot path.
   */
  async park(scope: AssignmentScope, groupId: string): Promise<void> {
    if (!scope.entityId) return;
    try {
      await this.conversationRepo.updateGroupAssignment(
        scope.entityId,
        groupId,
      );
    } catch (err: any) {
      this.logger.warn(
        `Failed to park conversation ${scope.entityId} under group ${groupId}: ${err.message}`,
      );
    }
  }
}
