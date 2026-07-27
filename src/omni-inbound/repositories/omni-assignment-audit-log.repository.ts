import { Injectable } from '@nestjs/common';
import {
  AssignmentAuditEntry,
  AssignmentAuditLogRepository as UnifiedAuditLogRepository,
} from '../../assignment/infrastructure/persistence/assignment-audit-log.repository';
import { AssignmentOutcome } from '../../assignment/domain/assignment.types';

/** Outcomes the conversation routing-history UI knows about. */
export type AuditOutcome = 'assigned' | 'queued' | 'failed';

/**
 * Conversation-shaped view of an assignment audit entry.
 *
 * Kept as its own shape — `conversationId` / `assignedAgentId` rather than
 * `entityId` / `assigneeId` — so the routing-trace panel and the routing history
 * page did not have to change when the two audit tables were merged. The
 * projection is one function wide; the storage underneath is shared.
 */
export interface AuditLogEntry {
  id: string;
  tenantId: string;
  conversationId: string;
  assignedAgentId: string | null;
  previousAgentId: string | null;
  ruleId: string | null;
  ruleName: string | null;
  channelType: string | null;
  agentPoolSize: number;
  eligiblePoolSize: number;
  strategy: string;
  reason: string;
  reasonKey: string | null;
  reasonParams: Record<string, any> | null;
  metadata: Record<string, any>;
  outcome: AuditOutcome;
  createdAt: string;
  updatedAt: string;
}

/**
 * Reads conversation assignment history from the single `assignment_audit_logs`
 * collection.
 *
 * Writes no longer pass through here: every decision — automatic, manual or
 * reply-triggered — is written by the assignment core, so there is exactly one
 * writer. That removes the failure mode this repository was created to work
 * around, where sharing a Mongoose model name with the record engine meant omni
 * audit rows were validated against the wrong schema and silently dropped.
 */
@Injectable()
export class AssignmentAuditLogRepository {
  constructor(private readonly unified: UnifiedAuditLogRepository) {}

  private toConversationEntry(entry: AssignmentAuditEntry): AuditLogEntry {
    return {
      id: entry.id,
      tenantId: entry.tenantId,
      conversationId: entry.entityId,
      assignedAgentId: entry.assigneeId,
      previousAgentId: entry.previousAssigneeId,
      ruleId: entry.ruleId,
      ruleName: entry.ruleName,
      channelType: entry.channelType,
      agentPoolSize: entry.candidatePoolSize,
      eligiblePoolSize: entry.eligiblePoolSize,
      strategy: entry.strategy,
      reason: entry.reason,
      reasonKey: entry.reasonKey,
      reasonParams: entry.reasonParams,
      metadata: {
        ...entry.metadata,
        groupId: entry.groupId,
        source: entry.source,
      },
      // `deferred` and `skipped` are outcomes only the core can report. The
      // conversation UI has three buckets and both of those mean "not assigned,
      // still waiting", so they project onto `queued` rather than inventing a
      // state the page cannot render.
      outcome:
        entry.outcome === 'assigned'
          ? 'assigned'
          : entry.outcome === 'failed'
            ? 'failed'
            : 'queued',
      createdAt: entry.createdAt,
      updatedAt: entry.createdAt,
    };
  }

  /** Newest-first page of decisions for one conversation. */
  async findByConversation(
    tenantId: string,
    conversationId: string,
    limit = 10,
    cursor?: string,
  ): Promise<{ entries: AuditLogEntry[]; nextCursor: string | null }> {
    const page = await this.unified.pageByEntity(
      tenantId,
      'Conversation',
      conversationId,
      limit,
      cursor,
    );
    return {
      entries: page.entries.map((e) => this.toConversationEntry(e)),
      nextCursor: page.nextCursor,
    };
  }

  async search(
    tenantId: string,
    filters: {
      conversationId?: string;
      outcome?: AuditOutcome;
      agentId?: string;
    },
    limit = 50,
  ): Promise<AuditLogEntry[]> {
    // A partial id cannot match an entityId. Returning [] beats a 500 from a
    // half-typed search box.
    if (
      filters.conversationId &&
      !/^[a-f\d]{24}$/i.test(filters.conversationId)
    ) {
      return [];
    }

    const entries = await this.unified.search(
      tenantId,
      {
        objectType: 'Conversation',
        entityId: filters.conversationId,
        assigneeId: filters.agentId,
        outcome: filters.outcome as AssignmentOutcome | undefined,
      },
      limit,
    );
    return entries.map((e) => this.toConversationEntry(e));
  }

  async findByAgent(
    tenantId: string,
    agentId: string,
    limit = 50,
  ): Promise<AuditLogEntry[]> {
    const entries = await this.unified.search(
      tenantId,
      { objectType: 'Conversation', assigneeId: agentId },
      limit,
    );
    return entries.map((e) => this.toConversationEntry(e));
  }
}
