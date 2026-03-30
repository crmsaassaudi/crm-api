import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  ActivityRepository,
  ConversationActivity,
} from '../repositories/activity.repository';
import { PaginationResponseDto } from '../../utils/dto/pagination-response.dto';

/**
 * ActivityService — listens to all conversation lifecycle events and
 * persists immutable audit trail entries.
 *
 * Handles:
 *   - omni.conversation.status_changed → status_changed
 *   - omni.conversation.assigned       → agent_assigned / agent_unassigned
 *   - omni.conversation.tag_added      → tag_added
 *   - omni.conversation.note_added     → note_added
 *   - omni.conversation.created        → conversation_created
 *   - omni.conversation.reopened       → conversation_reopened
 */
@Injectable()
export class ActivityService {
  private readonly logger = new Logger(ActivityService.name);

  constructor(private readonly activityRepo: ActivityRepository) {}

  /**
   * Fetch paginated activity timeline for a conversation.
   */
  async getActivities(
    conversationId: string,
    page = 1,
    limit = 50,
  ): Promise<PaginationResponseDto<ConversationActivity>> {
    return this.activityRepo.findByConversation(conversationId, page, limit);
  }

  // ─── Event listeners ────────────────────────────────────────────

  @OnEvent('omni.conversation.created')
  async onConversationCreated(event: {
    tenantId: string;
    conversationId: string;
    channelType: string;
    senderId: string;
  }) {
    await this.log(
      event.tenantId,
      event.conversationId,
      'system',
      null,
      'conversation_created',
      null,
      'open',
      { channelType: event.channelType, senderId: event.senderId },
    );
  }

  @OnEvent('omni.conversation.reopened')
  async onConversationReopened(event: {
    tenantId: string;
    conversationId: string;
    previousConversationId: string;
    reopenCount: number;
  }) {
    await this.log(
      event.tenantId,
      event.conversationId,
      'system',
      null,
      'conversation_reopened',
      event.previousConversationId,
      event.conversationId,
      {
        previousConversationId: event.previousConversationId,
        reopenCount: event.reopenCount,
      },
    );
  }

  @OnEvent('omni.conversation.status_changed')
  async onStatusChanged(event: {
    tenantId: string;
    conversationId: string;
    status: string;
    oldStatus: string;
    agentId: string;
    reason?: string;
  }) {
    await this.log(
      event.tenantId,
      event.conversationId,
      'agent',
      event.agentId,
      'status_changed',
      event.oldStatus,
      event.status,
      { reason: event.reason },
    );
  }

  @OnEvent('omni.conversation.assigned')
  async onAssigned(event: {
    tenantId: string;
    conversationId: string;
    agentId: string | null;
    oldAgentId: string | null;
  }) {
    const action = event.agentId ? 'agent_assigned' : 'agent_unassigned';
    await this.log(
      event.tenantId,
      event.conversationId,
      'agent',
      event.agentId ?? event.oldAgentId,
      action,
      event.oldAgentId,
      event.agentId,
    );
  }

  @OnEvent('omni.conversation.tag_added')
  async onTagAdded(event: {
    tenantId: string;
    conversationId: string;
    tag: string;
    agentId: string;
  }) {
    await this.log(
      event.tenantId,
      event.conversationId,
      'agent',
      event.agentId,
      'tag_added',
      null,
      event.tag,
    );
  }

  @OnEvent('omni.conversation.note_added')
  async onNoteAdded(event: {
    tenantId: string;
    conversationId: string;
    noteId: string;
    authorId: string;
    isPrivate: boolean;
    content: string;
  }) {
    await this.log(
      event.tenantId,
      event.conversationId,
      'agent',
      event.authorId,
      'note_added',
      null,
      event.noteId,
      { content: event.content, isPrivate: event.isPrivate },
    );
  }

  // ─── Helper ─────────────────────────────────────────────────────

  private async log(
    tenantId: string | null,
    conversationId: string,
    actorType: string,
    actorId: string | null,
    action: string,
    oldValue: string | null,
    newValue: string | null,
    metadata: Record<string, any> = {},
  ): Promise<void> {
    try {
      await this.activityRepo.create({
        tenantId: tenantId ?? undefined,
        conversationId,
        actorType,
        actorId,
        action,
        oldValue,
        newValue,
        metadata,
      } as any);
      this.logger.debug(`Activity logged: ${action} on ${conversationId}`);
    } catch (err) {
      this.logger.error(`Failed to log activity: ${err.message}`);
    }
  }
}
