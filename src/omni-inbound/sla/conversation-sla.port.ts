import { Injectable } from '@nestjs/common';
import { ConversationRepository } from '../repositories/conversation.repository';
import type {
  SlaSubjectContext,
  SlaSubjectPort,
  SlaSubjectProjection,
} from '../../sla-policies/clock/sla-subject.port';
import type { SlaSubjectType } from '../../sla-policies/clock/sla-clock.schema';

/**
 * How the SLA engine reads and writes a conversation.
 *
 * Behaviour is unchanged from when the engine talked to the conversation
 * repository directly; the indirection exists so tickets could join the same
 * engine without omni and tickets importing each other.
 */
@Injectable()
export class ConversationSlaPort implements SlaSubjectPort {
  readonly subjectType: SlaSubjectType = 'conversation';

  constructor(private readonly conversations: ConversationRepository) {}

  async loadContext(
    _tenantId: string,
    conversationId: string,
  ): Promise<SlaSubjectContext | null> {
    const conversation = await this.conversations.findById(conversationId);
    if (!conversation) return null;
    return { segment: (conversation as any).priority ?? null };
  }

  async project(
    _tenantId: string,
    conversationId: string,
    projection: SlaSubjectProjection,
  ): Promise<void> {
    const state: Parameters<ConversationRepository['projectSlaState']>[1] = {};

    // The conversation inbox shows one countdown, so the soonest of the two
    // deadlines wins — and the metric label with it. Only computed when the
    // engine actually sent deadlines; `policyId` alone must not blank them.
    if ('firstResponseDueAt' in projection || 'resolutionDueAt' in projection) {
      const first = projection.firstResponseDueAt ?? null;
      const resolution = projection.resolutionDueAt ?? null;
      const soonest =
        first && resolution
          ? first < resolution
            ? first
            : resolution
          : (first ?? resolution);
      state.slaDueAt = soonest;
      state.slaDueMetric =
        soonest === null
          ? null
          : soonest === first
            ? 'first_response'
            : 'resolution';
    }
    if ('breachedAt' in projection) state.breachedAt = projection.breachedAt;

    await this.conversations.projectSlaState(conversationId, state);
  }

  async recordAgentResponse(
    _tenantId: string,
    conversationId: string,
    respondedAt: Date,
    responderId: string | null,
  ): Promise<void> {
    // Credited to whoever sent it, not to the current assignee: a transfer
    // must not move the response time onto whoever happens to hold the
    // conversation later.
    await this.conversations.recordFirstResponse(
      conversationId,
      respondedAt,
      responderId,
    );
  }
}
