import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { OmniPayload } from '../domain/omni-payload';
import { OmniEvents } from '../domain/omni-events';
import { ConversationRepository } from '../repositories/conversation.repository';
import { ChannelsService } from '../../channels/channels.service';
import { AssignmentService } from './assignment.service';
import { AgentPresenceService } from './agent-presence.service';
import { AutoResolveService } from './auto-resolve.service';
import { BusinessHoursService } from './business-hours.service';
import { BotQueueService } from '../bot/bot-queue.service';
import { ConversationBotState } from '../domain/omni-conversation';

/**
 * InboundOrchestrationService — coordinates post-persistence side effects
 * for inbound messages.
 *
 * Extracted from ConversationService (T-001) to reduce the God Service's
 * responsibility scope. Handles:
 *
 *   1. Auto-assignment orchestration (channel config → agent pool → assign)
 *   2. Bot processing enqueue (if conversation has bot enabled)
 *   3. Business hours / OOO auto-reply checks
 *   4. Bot state resolution for new conversations
 *   5. Auto-resolve timer rescheduling
 *
 * ConversationService delegates to this service after persisting the message.
 */
@Injectable()
export class InboundOrchestrationService {
  private readonly logger = new Logger(InboundOrchestrationService.name);

  constructor(
    private readonly conversationRepo: ConversationRepository,
    private readonly channelsService: ChannelsService,
    private readonly assignmentService: AssignmentService,
    private readonly agentPresenceService: AgentPresenceService,
    private readonly autoResolveService: AutoResolveService,
    private readonly businessHoursService: BusinessHoursService,
    private readonly botQueueService: BotQueueService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ────────────────────────────────────────────────────────────────
  // Auto-Assignment Engine
  // ────────────────────────────────────────────────────────────────

  /**
   * Trigger auto-assignment for a conversation.
   *
   * Flow:
   * 1. Load channel config → supportUserIds + supportGroupIds
   * 2. Resolve group members into individual user IDs
   * 3. Merge into a deduplicated agent pool
   * 4. Call AssignmentService with routing context + agent pool
   * 5. Emit assignment event for real-time broadcast + activity trail
   *
   * If the channel has autoAssignmentEnabled = false, skip assignment.
   * If supportUserIds AND supportGroupIds are both empty, use all online agents.
   */
  async triggerAutoAssignment(
    payload: OmniPayload,
    conversationId: string,
    contactId: string | null,
    reason: string,
    enrichedProfile?: { name?: string; avatarUrl?: string; phone?: string },
  ): Promise<void> {
    try {
      this.logger.debug(
        `[AUTO-ASSIGN] triggerAutoAssignment for conversation=${conversationId}, reason=${reason}`,
      );

      // 1. Load channel config
      let channelConfig: Record<string, any> = {};
      try {
        const channel = await this.channelsService.findAnyByAccount(
          this.toSchemaChannelType(payload.channelType),
          payload.channelAccount,
        );
        channelConfig = channel?.config ?? {};
      } catch (_channelErr: any) {
        this.logger.debug(
          `Channel not found for ${payload.channelType}/${payload.channelAccount} — using default routing`,
        );
      }

      // 2. Channel-first auto-assignment hierarchy
      const channelAutoAssign = channelConfig.autoAssignmentEnabled;

      if (channelAutoAssign === false) {
        this.logger.log(
          `Auto-assignment explicitly disabled for channel ${payload.channelAccount} — skipping`,
        );
        return;
      }

      // 3. Build agent pool from channel's support config
      const supportUserIds: string[] = channelConfig.supportUserIds ?? [];
      const supportGroupIds: string[] = channelConfig.supportGroupIds ?? [];

      let agentPool: string[] | undefined = undefined;
      if (supportUserIds.length > 0 || supportGroupIds.length > 0) {
        const groupMemberIds =
          await this.resolveGroupMembersForAssignment(supportGroupIds);
        const allSupportIds = [
          ...new Set([...supportUserIds, ...groupMemberIds]),
        ];
        agentPool = allSupportIds.length > 0 ? allSupportIds : undefined;
      }

      // 4. Build routing context for rule evaluation
      const customerName =
        enrichedProfile?.name ??
        payload.metadata?.contactName ??
        payload.senderId;

      const routingContext = {
        channel: payload.channelType,
        tags: [],
        customerName,
        content: payload.content ?? '',
        time: this.getCurrentTimeHHmm(),
        segment: undefined,
      };

      // 5. Call AssignmentService
      const assignedAgentId = await this.assignmentService.assignConversation(
        payload.tenantId,
        conversationId,
        {
          agentPool,
          contactId,
          externalSenderId: payload.senderId,
          channelAutoAssignOverride: channelAutoAssign,
          routingContext,
          allowReassignment: reason === 'reopen_agent_offline',
        },
      );

      // 6. Emit assignment event for real-time broadcast
      if (assignedAgentId) {
        this.eventEmitter.emit(OmniEvents.CONVERSATION_ASSIGNED, {
          tenantId: payload.tenantId,
          conversationId,
          agentId: assignedAgentId,
          oldAgentId: null,
          strategy: 'auto',
          reason,
        });
        this.logger.log(
          `Auto-assigned conversation ${conversationId} → agent ${assignedAgentId} (reason: ${reason})`,
        );
      } else {
        this.logger.log(
          `Conversation ${conversationId} goes to queue — no available agent (reason: ${reason})`,
        );
      }
    } catch (err: any) {
      // Auto-assignment failure must NOT block message processing
      this.logger.error(
        `Auto-assignment failed for conversation ${conversationId}: ${err.message}`,
        err.stack,
      );
    }
  }

  /**
   * Check if an existing conversation's assigned agent is still available.
   * If not, trigger re-assignment.
   */
  async checkAndReassignIfNeeded(
    payload: OmniPayload,
    conversationId: string,
    assignedAgentId: string,
    contactId: string | null,
  ): Promise<void> {
    const presence = await this.agentPresenceService.getPresence(
      payload.tenantId,
      assignedAgentId,
    );

    if (!presence || presence.status !== 'available') {
      this.logger.debug(
        `Agent ${assignedAgentId} offline for conversation ${conversationId} — re-assigning`,
      );
      await this.triggerAutoAssignment(
        payload,
        conversationId,
        contactId,
        'reopen_agent_offline',
      );
    }
  }

  // ────────────────────────────────────────────────────────────────
  // Bot Orchestration
  // ────────────────────────────────────────────────────────────────

  /**
   * Resolve the initial bot state for a new conversation.
   */
  async resolveInitialBotState(
    tenantId: string,
    channelType: string,
    channelAccount: string,
  ): Promise<ConversationBotState> {
    const botConfig = await this.getChannelBotConfig(
      tenantId,
      channelType,
      channelAccount,
    );

    return {
      enabled: Boolean(botConfig?.enabled),
      provider: botConfig?.provider ?? 'typebot',
      flowId: null,
      sessionId: null,
      status: 'active',
      lastError: null,
      lockedAt: null,
    };
  }

  /**
   * Read bot enabled flag from channel config.
   */
  async getChannelBotConfig(
    tenantId: string,
    channelType: string,
    channelAccount: string,
  ): Promise<{ enabled: boolean; provider: string } | undefined> {
    try {
      const channel = await this.channelsService.findAnyByAccount(
        channelType,
        channelAccount,
      );

      if (!channel?.config) return undefined;

      // Validate tenant ownership (defense-in-depth)
      if (channel.tenantId !== tenantId) {
        this.logger.warn(
          `Bot config tenant mismatch: channel ${channel.id} belongs to ${channel.tenantId}, not ${tenantId}`,
        );
        return undefined;
      }

      const config = channel.config;
      if (!config.botEnabled) return undefined;

      return {
        enabled: Boolean(config.botEnabled),
        provider: config.botProvider ?? 'typebot',
      };
    } catch (err) {
      this.logger.debug(
        `Channel bot config lookup failed for ${channelType}/${channelAccount}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return undefined;
    }
  }

  /**
   * Enqueue bot processing for an inbound message if the conversation has bot enabled.
   */
  async enqueueBotProcessingIfNeeded(
    payload: OmniPayload,
    conversationId: string,
    inboundMessageId: string,
  ): Promise<void> {
    if (payload.senderType !== 'customer') return;

    const botProcessableTypes = new Set([
      'text',
      'image',
      'video',
      'audio',
      'file',
      'document',
      'sticker',
    ]);
    const isInteractive = !!payload.metadata?.replyId;
    if (!botProcessableTypes.has(payload.messageType) && !isInteractive) return;

    try {
      const conversation = await this.conversationRepo.findById(conversationId);
      if (!conversation?.bot?.enabled) {
        this.logger.debug(
          `Bot not enabled for conversation ${conversationId} — skipping bot queue`,
        );
        return;
      }

      let text = payload.content;
      if (!text?.trim() && payload.messageType !== 'text') {
        text = `[${payload.messageType}]`;
      }

      await this.botQueueService.enqueueInboundMessage({
        tenantId: payload.tenantId,
        org: payload.tenantId,
        channelId: payload.channelId,
        conversationId,
        messageId: inboundMessageId,
        text: text || '',
        channel: payload.channelType,
        replyId: payload.metadata?.replyId,
        messageType: payload.messageType,
      });
    } catch (error) {
      this.logger.error(
        `Failed to enqueue bot job for inbound message ${inboundMessageId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  // ────────────────────────────────────────────────────────────────
  // Business Hours / OOO
  // ────────────────────────────────────────────────────────────────

  /**
   * Check if this message arrived outside business hours.
   * If so, optionally:
   *   - Send an out-of-office auto-reply message
   *   - Set the conversation status to 'pending'
   */
  async handleBusinessHoursCheck(
    payload: OmniPayload,
    conversationId: string,
  ): Promise<void> {
    try {
      const withinHours = await this.businessHoursService.isWithinBusinessHours(
        payload.tenantId,
      );

      if (withinHours) {
        return;
      }

      const oooConfig = await this.businessHoursService.getOOOConfig(
        payload.tenantId,
      );

      if (!oooConfig.oooAutoReplyEnabled) {
        return;
      }

      if (oooConfig.oooSetPending) {
        await this.conversationRepo.updateStatus(conversationId, 'pending');
        this.logger.log(
          `Set conversation ${conversationId} to pending (outside business hours)`,
        );
      }

      const oooMessage = this.businessHoursService.getChannelOOOMessage(
        oooConfig,
        payload.channelType,
      );
      if (oooMessage) {
        this.eventEmitter.emit(OmniEvents.OOO_AUTO_REPLY, {
          tenantId: payload.tenantId,
          conversationId,
          channelType: payload.channelType,
          channelAccount: payload.channelAccount,
          senderId: payload.senderId,
          message: oooMessage,
          externalConversationId: payload.externalConversationId,
        });

        this.logger.log(
          `Emitted OOO auto-reply for conversation ${conversationId} ` +
            `(channel: ${payload.channelType})`,
        );
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Business hours check failed for conversation ${conversationId}: ${errorMessage}`,
      );
    }
  }

  // ────────────────────────────────────────────────────────────────
  // Auto-Resolve Timer
  // ────────────────────────────────────────────────────────────────

  /**
   * Reschedule the auto-resolve timer after a new message.
   */
  async rescheduleAutoResolve(
    tenantId: string,
    conversationId: string,
  ): Promise<void> {
    await this.autoResolveService.rescheduleAutoResolve(
      tenantId,
      conversationId,
    );
  }

  /**
   * Cancel the auto-resolve timer (conversation resolved/closed).
   */
  async cancelAutoResolve(conversationId: string): Promise<void> {
    await this.autoResolveService.cancelAutoResolve(conversationId);
  }

  /**
   * Release agent presence when conversation is resolved/closed.
   */
  async releaseConversation(tenantId: string, agentId: string): Promise<void> {
    await this.agentPresenceService.releaseConversation(tenantId, agentId);
  }

  // ────────────────────────────────────────────────────────────────
  // Private Helpers
  // ────────────────────────────────────────────────────────────────

  private async resolveGroupMembersForAssignment(
    groupIds: string[],
  ): Promise<string[]> {
    if (groupIds.length === 0) return [];
    return this.assignmentService.resolveGroupMembers(groupIds);
  }

  private getCurrentTimeHHmm(): string {
    const now = new Date();
    return `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
  }

  private toSchemaChannelType(type: string): string {
    return type.toLowerCase();
  }
}
