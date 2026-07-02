import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { OmniPayload } from '../domain/omni-payload';
import {
  OmniEvents,
  ReplyAutoAssignEvent,
  BotHandoffEvent,
} from '../domain/omni-events';
import { ConversationRepository } from '../repositories/conversation.repository';
import { ChannelsService } from '../../channels/channels.service';
import { AssignmentService } from './assignment.service';
import { AgentPresenceService } from './agent-presence.service';
import { AutoResolveService } from './auto-resolve.service';
import { BusinessHoursService } from './business-hours.service';
import { BotQueueService } from '../bot/bot-queue.service';
import {
  ConversationBotState,
  BotMode,
} from '../domain/omni-conversation';

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

      // Per-channel routing overrides (strategy/capacity/sticky/skills).
      // Undefined fields inherit from the global omni_routing config via
      // mergeRoutingConfig() inside AssignmentService.
      const channelRoutingOverride = channelConfig.routing;

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

      // F-03 fix: fetch conversation tags and VIP flag to populate routing context.
      // Previously these were hardcoded to [] / undefined, making any admin-configured
      // tag-based or segment-based routing rules permanently unreachable.
      let conversationTags: string[] = [];
      let conversationIsVip: boolean | undefined;
      try {
        const conv = await this.conversationRepo.findById(conversationId);
        conversationTags = conv?.tags ?? [];
        conversationIsVip = (conv as any)?.isVip;
      } catch {
        // Non-fatal — routing context will fall back to empty/undefined
      }

      const routingContext = {
        channel: payload.channelType,
        tags: conversationTags,
        customerName,
        content: payload.content ?? '',
        time: this.getCurrentTimeHHmm(),
        // Map the VIP flag to the segment field expected by routing rules.
        // Admins can configure rules like: segment eq 'VIP' → route to Tier-2 team.
        segment: conversationIsVip === true ? 'VIP' : undefined,
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
          channelRoutingOverride,
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
          strategy: reason === 'bot_handoff' ? 'bot_handoff' : 'auto',
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
   * Check if an existing conversation's assigned agent is still reachable.
   * Reassignment is triggered ONLY when the agent has actually disconnected —
   * not when they are merely 'busy' or 'away', which are valid working states.
   *
   * Architecture note (F-08 fix):
   *   Previously compared `presence.status !== 'available'` which uses the
   *   *display* status. Agents in 'busy' or 'away' state have display status
   *   that is not 'available', causing their conversations to be silently stolen
   *   on every inbound customer message. The correct check is `connectionStatus`,
   *   which is 'disconnected' only when the socket layer has confirmed the agent
   *   is unreachable.
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

    // No presence record means the agent has fully expired from Redis → treat as offline.
    // 'disconnected' connectionStatus means the socket layer lost the agent — reassign.
    // 'busy' / 'away' agents are intentional working states — do NOT reassign.
    const agentIsGone =
      !presence || presence.connectionStatus === 'DISCONNECTED';

    if (agentIsGone) {
      this.logger.debug(
        `Agent ${assignedAgentId} is disconnected/gone for conversation ${conversationId} — re-assigning`,
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
   *
   * Conversation bot is ALWAYS enabled by default. The channel-level
   * botEnabled flag acts as a master switch checked at enqueue time.
   * Agent can explicitly disable bot per conversation (override).
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
      enabled: true, // always default ON — channel master switch decides at runtime
      provider: botConfig?.provider ?? 'typebot',
      flowId: null,
      sessionId: null,
      status: 'active',
      lastError: null,
      lockedAt: null,
    };
  }

  /**
   * Read bot config from channel. Always returns an object with enabled flag
   * (never undefined) so callers can distinguish "channel has no config" from
   * "channel explicitly disabled bot".
   */
  async getChannelBotConfig(
    tenantId: string,
    channelType: string,
    channelAccount: string,
  ): Promise<{ enabled: boolean; provider: string; botMode: BotMode }> {
    this.logger.log(
      `[BOT-CONFIG] Looking up bot config: channelType=${channelType}, channelAccount=${channelAccount}, tenantId=${tenantId}`,
    );
    try {
      // FIX: For livechat, channelAccount is the MongoDB _id (channelId),
      // NOT the `account` field (lc_<ulid>). findAnyByAccount queries
      // { type, account } which never matches a MongoDB _id, causing
      // the channel lookup to silently fail and disable bot processing.
      let channel: any;
      if (channelType === 'livechat') {
        channel = await this.channelsService.findById(channelAccount);
        this.logger.log(
          `[BOT-CONFIG] Livechat channel lookup by _id=${channelAccount}: found=${!!channel}`,
        );
      } else {
        channel = await this.channelsService.findAnyByAccount(
          channelType,
          channelAccount,
        );
        this.logger.log(
          `[BOT-CONFIG] Channel lookup by account: found=${!!channel}, channelId=${channel?.id}`,
        );
      }

      if (!channel?.config) {
        this.logger.log(
          `[BOT-CONFIG] Channel found but has no config — returning enabled=false`,
        );
        return { enabled: false, provider: 'typebot', botMode: 'disabled' };
      }

      // Validate tenant ownership (defense-in-depth)
      if (channel.tenantId !== tenantId) {
        this.logger.warn(
          `Bot config tenant mismatch: channel ${channel.id} belongs to ${channel.tenantId}, not ${tenantId}`,
        );
        return { enabled: false, provider: 'typebot', botMode: 'disabled' };
      }

      // Resolve botMode: explicit config > derive from botEnabled flag > disabled
      const rawBotMode = channel.config.botMode as string | undefined;
      const botEnabled = Boolean(channel.config.botEnabled);
      const botMode: BotMode = rawBotMode === 'bot_first' || rawBotMode === 'bot_only' || rawBotMode === 'disabled'
        ? rawBotMode
        : botEnabled ? 'bot_first' : 'disabled';

      const result = {
        enabled: botEnabled,
        provider: channel.config.botProvider ?? 'typebot',
        botMode,
      };
      this.logger.log(
        `[BOT-CONFIG] Result: enabled=${result.enabled}, provider=${result.provider}, ` +
          `botMode=${result.botMode}, botEnabled raw=${channel.config.botEnabled}`,
      );
      return result;
    } catch (err) {
      this.logger.warn(
        `[BOT-CONFIG] Channel bot config lookup FAILED for ${channelType}/${channelAccount}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return { enabled: false, provider: 'typebot', botMode: 'disabled' };
    }
  }

  /**
   * Enqueue bot processing for an inbound message.
   *
   * Two-level bot toggle:
   *   1. Channel level (master switch) — if OFF, bot never runs
   *   2. Conversation level (per-conversation override, default ON)
   *      — only skips when agent explicitly disabled bot on this conversation
   *
   * Default: conversation.bot.enabled = true (always).
   * Legacy conversations without bot state are treated as enabled.
   */
  async enqueueBotProcessingIfNeeded(
    payload: OmniPayload,
    conversationId: string,
    inboundMessageId: string,
  ): Promise<void> {
    this.logger.log(
      `[BOT-FLOW] ▶ enqueueBotProcessingIfNeeded START — ` +
        `msg=${inboundMessageId}, conv=${conversationId}, ` +
        `channel=${payload.channelType}/${payload.channelAccount}, ` +
        `senderType=${payload.senderType}, messageType=${payload.messageType}`,
    );

    if (payload.senderType !== 'customer') {
      this.logger.log(
        `[BOT-FLOW] ✗ SKIP — senderType="${payload.senderType}" (not customer), msg=${inboundMessageId}`,
      );
      return;
    }

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
    if (!botProcessableTypes.has(payload.messageType) && !isInteractive) {
      this.logger.log(
        `[BOT-FLOW] ✗ SKIP — messageType="${payload.messageType}" not processable and not interactive, msg=${inboundMessageId}`,
      );
      return;
    }

    try {
      // ── Level 1: Channel master switch ──────────────────────────────
      this.logger.log(
        `[BOT-FLOW] Checking Level 1: Channel bot master switch...`,
      );
      const channelBotConfig = await this.getChannelBotConfig(
        payload.tenantId,
        payload.channelType,
        payload.channelAccount,
      );
      this.logger.log(
        `[BOT-FLOW] Channel bot config result: enabled=${channelBotConfig.enabled}, provider=${channelBotConfig.provider}`,
      );
      if (!channelBotConfig.enabled) {
        this.logger.log(
          `[BOT-FLOW] ✗ SKIP — Bot DISABLED on channel ${payload.channelType}/${payload.channelAccount}, msg=${inboundMessageId}`,
        );
        return;
      }

      // ── Level 2: Conversation override ─────────────────────────────
      // Default: enabled (conversation.bot.enabled defaults to true).
      // Only skip when agent EXPLICITLY disabled bot on this conversation.
      this.logger.log(
        `[BOT-FLOW] Checking Level 2: Conversation bot override...`,
      );
      const conversation = await this.conversationRepo.findById(conversationId);
      if (!conversation) {
        this.logger.warn(
          `[BOT-FLOW] ✗ SKIP — Conversation ${conversationId} NOT FOUND in DB, msg=${inboundMessageId}`,
        );
        return;
      }

      this.logger.log(
        `[BOT-FLOW] Conversation bot state: bot=${JSON.stringify(conversation.bot ?? null)}, status=${conversation.status}`,
      );

      if (conversation.bot?.enabled === false) {
        this.logger.log(
          `[BOT-FLOW] ✗ SKIP — Bot explicitly DISABLED by agent on conversation ${conversationId}, msg=${inboundMessageId}`,
        );
        return;
      }

      // Auto-initialize bot state for legacy conversations (no bot field)
      if (!conversation.bot) {
        this.logger.log(
          `[BOT-FLOW] Auto-initializing bot state for legacy conversation ${conversationId}`,
        );
        await this.conversationRepo.updateBotState(conversationId, {
          enabled: true,
          provider: channelBotConfig.provider,
          status: 'active',
        });
      }

      let text = payload.content;
      if (!text?.trim() && payload.messageType !== 'text') {
        text = `[${payload.messageType}]`;
      }

      this.logger.log(
        `[BOT-FLOW] ✓ ENQUEUING bot job — conv=${conversationId}, msg=${inboundMessageId}, text="${(text || '').substring(0, 50)}"`,
      );

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

      this.logger.log(
        `[BOT-FLOW] ✓ Bot job ENQUEUED successfully — conv=${conversationId}, msg=${inboundMessageId}`,
      );
    } catch (error) {
      this.logger.error(
        `[BOT-FLOW] ✗ FAILED to enqueue bot job for msg=${inboundMessageId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        error instanceof Error ? error.stack : undefined,
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
   *
   * F-11 fix: if an agent has already been assigned, skip OOO entirely.
   * Sending "we are offline" immediately after agent assignment creates a
   * contradictory and unprofessional customer experience.
   */
  async handleBusinessHoursCheck(
    payload: OmniPayload,
    conversationId: string,
    assignedAgentId?: string | null,
  ): Promise<void> {
    try {
      // F-11: if the routing engine already found an available agent, OOO is moot.
      if (assignedAgentId) {
        return;
      }

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
  // Reply Auto-Assignment
  // ────────────────────────────────────────────────────────────────

  /**
   * When an agent replies to an unassigned conversation, implicitly assign
   * it to that agent. This is fire-and-forget — failures must NOT block
   * message delivery.
   *
   * Flow:
   *   1. Atomic `assignIfUnassigned` (MongoDB CAS — safe against races)
   *   2. Increment agent presence counter
   *   3. Write audit log (`strategy: reply_auto_assign`)
   *   4. Broadcast assignment event so other agents' UIs update
   */
  @OnEvent(OmniEvents.REPLY_AUTO_ASSIGN)
  async handleReplyAutoAssign(event: ReplyAutoAssignEvent): Promise<void> {
    const { tenantId, conversationId, agentId, channelType } = event;

    try {
      // 1. Atomically assign only if still unassigned (prevents double-assign)
      const committed = await this.conversationRepo.assignIfUnassigned(
        conversationId,
        agentId,
      );

      if (!committed) {
        // Already assigned by another agent or routing — no action needed
        this.logger.debug(
          `Reply auto-assign skipped: conversation ${conversationId} already assigned`,
        );
        return;
      }

      // 2. Increment the agent's active conversation counter.
      // Manual/reply path: assignment did NOT go through the routing engine, so
      // no Lua reserve incremented the counter — we must increment here. (The
      // auto-assign path in triggerAutoAssignment increments inside the reserve
      // Lua, so it must NOT call assignConversation() again — avoid double-count.)
      await this.agentPresenceService.assignConversation(tenantId, agentId);

      // 3. Audit trail
      await this.assignmentService.logReplyAutoAssignment({
        conversationId,
        tenantId,
        agentId,
        channelType,
      });

      // 4. Broadcast assignment to all connected agents
      this.eventEmitter.emit(OmniEvents.CONVERSATION_ASSIGNED, {
        tenantId,
        conversationId,
        agentId,
        oldAgentId: null,
        strategy: 'reply_auto_assign',
        reason: 'Agent replied to unassigned conversation',
      });

      this.logger.log(
        `Reply auto-assigned conversation ${conversationId} → agent ${agentId}`,
      );
    } catch (err: any) {
      // Non-blocking — reply delivery must not be affected
      this.logger.warn(
        `Reply auto-assign failed for conversation ${conversationId}: ${err.message}`,
      );
    }
  }

  // ────────────────────────────────────────────────────────────────
  // Bot Handoff → Auto-Assignment
  // ────────────────────────────────────────────────────────────────

  /**
   * When bot hands off a conversation to a human agent, trigger
   * auto-assignment. This is the deferred assignment that was skipped
   * during conversation creation when botMode = 'bot_first'.
   */
  @OnEvent(OmniEvents.BOT_HANDOFF)
  async handleBotHandoff(event: BotHandoffEvent): Promise<void> {
    const { tenantId, conversationId, channelType, channelAccount, contactId } =
      event;

    try {
      this.logger.log(
        `[BOT-HANDOFF] Triggering deferred auto-assignment for conv=${conversationId}`,
      );

      // Build a minimal OmniPayload for the assignment engine
      const syntheticPayload = {
        tenantId,
        channelType,
        channelAccount,
        senderId: '',
        channelId: '',
        externalConversationId: '',
        content: '',
        messageType: 'text',
        senderType: 'customer',
        timestamp: new Date(),
        metadata: {},
      } as OmniPayload;

      await this.triggerAutoAssignment(
        syntheticPayload,
        conversationId,
        contactId,
        'bot_handoff',
      );
    } catch (err: any) {
      // Non-blocking — handoff must still complete even if assignment fails
      this.logger.error(
        `[BOT-HANDOFF] Auto-assignment failed for conv=${conversationId}: ${err.message}`,
        err.stack,
      );
    }
  }

  /**
   * Check if a conversation is currently in bot-first mode with an active bot.
   * Used by ConversationService to decide whether to defer auto-assignment.
   */
  async isBotFirstActive(
    tenantId: string,
    channelType: string,
    channelAccount: string,
  ): Promise<boolean> {
    const botConfig = await this.getChannelBotConfig(
      tenantId,
      channelType,
      channelAccount,
    );
    return botConfig.botMode === 'bot_first' || botConfig.botMode === 'bot_only';
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
