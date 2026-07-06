import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import {
  ActivityRepository,
  ConversationActivity,
} from '../repositories/activity.repository';
import { PaginationResponseDto } from '../../utils/dto/pagination-response.dto';
import { UsersService } from '../../users/users.service';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { OmniEvents } from '../domain/omni-events';

/** Bundled parameters for the private log helper (S107: keeps param count ≤ 7). */
interface ActivityLogParams {
  tenantId: string | null;
  conversationId: string;
  actorType: string;
  actorId: string | null;
  action: string;
  oldValue: string | null;
  newValue: string | null;
  metadata?: Record<string, any>;
  description?: string | null;
}

/**
 * ActivityService — listens to all conversation lifecycle events and
 * persists immutable audit trail entries with human-readable descriptions.
 *
 * After persisting, emits `omni.activity.created` for real-time broadcast
 * via OmniGateway → Socket.IO → frontend inline system messages.
 *
 * Handles:
 *   - omni.conversation.created         → conversation_created
 *   - omni.conversation.reopened        → conversation_reopened
 *   - omni.conversation.status_changed  → status_changed / auto_resolved
 *   - omni.conversation.assigned        → agent_assigned / agent_unassigned / group_assigned / group_unassigned
 *   - omni.conversation.tag_added       → tag_added
 *   - omni.conversation.tag_removed     → tag_removed
 *   - omni.conversation.note_added      → note_added
 *   - omni.conversation.sla_breached    → sla_breached
 *   - omni.conversation.escalated       → escalated
 *   - omni.conversation.ticket_created  → ticket_created
 *   - omni.conversation.deal_created    → deal_created
 *   - omni.contact.auto_merged          → identity_merged
 */
@Injectable()
export class ActivityService {
  private readonly logger = new Logger(ActivityService.name);

  constructor(
    private readonly activityRepo: ActivityRepository,
    private readonly eventEmitter: EventEmitter2,
    private readonly usersService: UsersService,
    @InjectModel('GroupSchemaClass')
    private readonly groupModel: Model<any>,
  ) {}

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
    const channelLabel = this.channelLabel(event.channelType);
    await this.log({
      tenantId: event.tenantId,
      conversationId: event.conversationId,
      actorType: 'system',
      actorId: null,
      action: 'conversation_created',
      oldValue: null,
      newValue: 'open',
      metadata: { channelType: event.channelType, senderId: event.senderId },
      description: `Cuộc hội thoại mới từ kênh ${channelLabel}`,
    });
  }

  @OnEvent('omni.conversation.reopened')
  async onConversationReopened(event: {
    tenantId: string;
    conversationId: string;
    previousConversationId: string;
    reopenCount: number;
  }) {
    await this.log({
      tenantId: event.tenantId,
      conversationId: event.conversationId,
      actorType: 'system',
      actorId: null,
      action: 'conversation_reopened',
      oldValue: event.previousConversationId,
      newValue: event.conversationId,
      metadata: {
        previousConversationId: event.previousConversationId,
        reopenCount: event.reopenCount,
      },
      description: `Khách hàng quay lại — cuộc hội thoại được mở lại (lần thứ ${event.reopenCount})`,
    });
  }

  @OnEvent('omni.conversation.status_changed')
  async onStatusChanged(event: {
    tenantId: string;
    conversationId: string;
    status: string;
    oldStatus: string;
    agentId: string;
    reason?: string;
    resolveSource?: string;
  }) {
    // If auto-resolved by the system, use a separate action
    if (event.resolveSource === 'auto' || event.resolveSource === 'system') {
      const reasonText = event.reason
        ? ` (${this.humanizeReason(event.reason)})`
        : '';
      await this.log({
        tenantId: event.tenantId,
        conversationId: event.conversationId,
        actorType: 'system',
        actorId: null,
        action: 'auto_resolved',
        oldValue: event.oldStatus,
        newValue: event.status,
        metadata: { reason: event.reason, resolveSource: event.resolveSource },
        description: `Hệ thống đã tự động resolve cuộc hội thoại${reasonText}`,
      });
      return;
    }

    const actorName = await this.resolveActorName(event.agentId);
    const statusLabel = this.statusLabel(event.status);
    const reasonText = event.reason
      ? ` (${this.humanizeReason(event.reason)})`
      : '';

    await this.log({
      tenantId: event.tenantId,
      conversationId: event.conversationId,
      actorType: 'agent',
      actorId: event.agentId,
      action: 'status_changed',
      oldValue: event.oldStatus,
      newValue: event.status,
      metadata: { reason: event.reason, resolveSource: event.resolveSource },
      description: `${actorName} đã ${statusLabel} cuộc hội thoại${reasonText}`,
    });
  }

  @OnEvent('omni.conversation.assigned')
  async onAssigned(event: {
    tenantId: string;
    conversationId: string;
    agentId: string | null;
    oldAgentId: string | null;
    groupId?: string | null;
    oldGroupId?: string | null;
    strategy?: string;
    reason?: string;
    performedByUserId?: string | null;
  }) {
    this.logger.debug(
      `[onAssigned] event received: agentId=${event.agentId}, oldAgentId=${event.oldAgentId}, ` +
        `groupId=${event.groupId}, oldGroupId=${event.oldGroupId}, performedBy=${event.performedByUserId}`,
    );

    const isManual = !!event.performedByUserId && !event.strategy;
    const isAutoRoutingRule = !!event.strategy;
    const performerName = event.performedByUserId
      ? await this.resolveActorName(event.performedByUserId)
      : null;

    const actorPrefix = this.buildActorPrefix(
      isManual,
      isAutoRoutingRule,
      performerName,
      event.strategy,
    );

    const commonContext = {
      isManual,
      performerName,
      actorPrefix,
    };

    // ── Agent assignment activity ─────────────────────────────────
    await this.handleAgentAssignment(event, commonContext);

    // ── Group assignment activity ─────────────────────────────────
    await this.handleGroupAssignment(event, commonContext);
  }

  @OnEvent('omni.conversation.tag_added')
  async onTagAdded(event: {
    tenantId: string;
    conversationId: string;
    tag: string;
    agentId: string;
  }) {
    const actorName = await this.resolveActorName(event.agentId);
    await this.log({
      tenantId: event.tenantId,
      conversationId: event.conversationId,
      actorType: 'agent',
      actorId: event.agentId,
      action: 'tag_added',
      oldValue: null,
      newValue: event.tag,
      metadata: {},
      description: `${actorName} đã thêm thẻ "${event.tag}"`,
    });
  }

  @OnEvent('omni.conversation.tag_removed')
  async onTagRemoved(event: {
    tenantId: string;
    conversationId: string;
    tag: string;
    agentId: string;
  }) {
    const actorName = await this.resolveActorName(event.agentId);
    await this.log({
      tenantId: event.tenantId,
      conversationId: event.conversationId,
      actorType: 'agent',
      actorId: event.agentId,
      action: 'tag_removed',
      oldValue: event.tag,
      newValue: null,
      metadata: {},
      description: `${actorName} đã gỡ thẻ "${event.tag}"`,
    });
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
    const actorName = await this.resolveActorName(event.authorId);
    const visibility = event.isPrivate ? 'nội bộ' : 'công khai';
    await this.log({
      tenantId: event.tenantId,
      conversationId: event.conversationId,
      actorType: 'agent',
      actorId: event.authorId,
      action: 'note_added',
      oldValue: null,
      newValue: event.noteId,
      metadata: { content: event.content, isPrivate: event.isPrivate },
      description: `${actorName} đã thêm ghi chú ${visibility}`,
    });
  }

  // ─── New event listeners ────────────────────────────────────────

  @OnEvent('omni.conversation.sla_breached')
  async onSlaBreach(event: {
    tenantId: string;
    conversationId: string;
    slaType: string;
    deadline: string;
  }) {
    const slaLabel =
      event.slaType === 'first_response'
        ? 'Thời gian phản hồi đầu tiên (FRT)'
        : 'Thời gian xử lý';
    await this.log({
      tenantId: event.tenantId,
      conversationId: event.conversationId,
      actorType: 'system',
      actorId: null,
      action: 'sla_breached',
      oldValue: null,
      newValue: event.slaType,
      metadata: { deadline: event.deadline, slaType: event.slaType },
      description: `⚠️ Vi phạm SLA: ${slaLabel} đã quá hạn`,
    });
  }

  @OnEvent('omni.conversation.escalated')
  async onEscalated(event: {
    tenantId: string;
    conversationId: string;
    level: number;
    escalatedTo?: string;
    reason?: string;
  }) {
    const targetName = event.escalatedTo
      ? await this.resolveActorName(event.escalatedTo)
      : 'quản lý';
    await this.log({
      tenantId: event.tenantId,
      conversationId: event.conversationId,
      actorType: 'system',
      actorId: null,
      action: 'escalated',
      oldValue: null,
      newValue: String(event.level),
      metadata: {
        level: event.level,
        escalatedTo: event.escalatedTo,
        reason: event.reason,
      },
      description: `Cuộc hội thoại đã được leo thang (cấp ${event.level}) tới ${targetName}`,
    });
  }

  @OnEvent('omni.conversation.ticket_created')
  async onTicketCreated(event: {
    tenantId: string;
    conversationId: string;
    ticketId: string;
    subject: string;
    agentId: string;
  }) {
    const actorName = await this.resolveActorName(event.agentId);
    await this.log({
      tenantId: event.tenantId,
      conversationId: event.conversationId,
      actorType: 'agent',
      actorId: event.agentId,
      action: 'ticket_created',
      oldValue: null,
      newValue: event.ticketId,
      metadata: { ticketId: event.ticketId, subject: event.subject },
      description: `${actorName} đã tạo Ticket: "${event.subject}"`,
    });
  }

  @OnEvent('omni.conversation.deal_created')
  async onDealCreated(event: {
    tenantId: string;
    conversationId: string;
    dealId: string;
    title: string;
    agentId: string;
  }) {
    const actorName = await this.resolveActorName(event.agentId);
    await this.log({
      tenantId: event.tenantId,
      conversationId: event.conversationId,
      actorType: 'agent',
      actorId: event.agentId,
      action: 'deal_created',
      oldValue: null,
      newValue: event.dealId,
      metadata: { dealId: event.dealId, title: event.title },
      description: `${actorName} đã tạo Deal: "${event.title}"`,
    });
  }

  @OnEvent('omni.contact.auto_merged')
  async onIdentityMerged(event: {
    tenantId: string;
    conversationId?: string;
    existingContactId: string;
    senderId: string;
    channelType: string;
    matchedBy: string;
  }) {
    if (!event.conversationId) return;
    const channelLabel = this.channelLabel(event.channelType);
    await this.log({
      tenantId: event.tenantId,
      conversationId: event.conversationId,
      actorType: 'system',
      actorId: null,
      action: 'identity_merged',
      oldValue: null,
      newValue: event.existingContactId,
      metadata: {
        existingContactId: event.existingContactId,
        senderId: event.senderId,
        channelType: event.channelType,
        matchedBy: event.matchedBy,
      },
      description: `Hệ thống đã tự động liên kết danh tính ${channelLabel} với hồ sơ khách hàng (khớp ${event.matchedBy})`,
    });
  }

  @OnEvent('omni.conversation.takeover')
  async onConversationTakeover(event: {
    tenantId: string;
    conversationId: string;
    previousAgentId: string | null;
    previousAgentName?: string | null;
    newAgentId: string;
    newAgentName?: string | null;
    reason?: string;
    force?: boolean;
    lockExpiresAt?: string;
  }) {
    const newAgentName =
      event.newAgentName ?? (await this.resolveActorName(event.newAgentId));
    const previousAgentName = event.previousAgentId
      ? (event.previousAgentName ??
        (await this.resolveActorName(event.previousAgentId)))
      : 'chưa có agent';
    const reasonText = event.reason ? ` (${event.reason})` : '';

    await this.log({
      tenantId: event.tenantId,
      conversationId: event.conversationId,
      actorType: 'agent',
      actorId: event.newAgentId,
      action: 'conversation_takeover',
      oldValue: event.previousAgentId,
      newValue: event.newAgentId,
      metadata: {
        previousAgentId: event.previousAgentId,
        previousAgentName,
        newAgentId: event.newAgentId,
        newAgentName,
        reason: event.reason,
        force: event.force,
        lockExpiresAt: event.lockExpiresAt,
      },
      description: `${newAgentName} đã tiếp quản hội thoại từ ${previousAgentName}${reasonText}`,
    });
  }

  @OnEvent(OmniEvents.CONVERSATION_QUEUED)
  async onConversationQueued(event: {
    tenantId: string;
    conversationId: string;
    strategy: string;
    reason: string;
    channelType: string;
    queuedSince: Date;
    agentPoolSize: number;
  }) {
    await this.log({
      tenantId: event.tenantId,
      conversationId: event.conversationId,
      actorType: 'system',
      actorId: null,
      action: 'status_changed',
      oldValue: null,
      newValue: 'queued',
      metadata: {
        strategy: event.strategy,
        reason: event.reason,
        channelType: event.channelType,
        agentPoolSize: event.agentPoolSize,
      },
      description: `Hội thoại đang chờ phân công (${event.strategy}) — ${event.reason}`,
    });
  }

  @OnEvent(OmniEvents.BOT_HANDOFF)
  async onBotHandoff(event: {
    tenantId: string;
    conversationId: string;
    channelType: string;
    channelAccount: string;
    contactId: string | null;
  }) {
    await this.log({
      tenantId: event.tenantId,
      conversationId: event.conversationId,
      actorType: 'system',
      actorId: null,
      action: 'bot_handoff',
      oldValue: 'active',
      newValue: 'handoff',
      metadata: {
        channelType: event.channelType,
        channelAccount: event.channelAccount,
        contactId: event.contactId,
      },
      description: 'Bot đã hoàn tất flow và chuyển hội thoại cho tư vấn viên',
    });
  }

  // ─── Helpers ────────────────────────────────────────────────────

  private async log(params: ActivityLogParams): Promise<void> {
    const {
      tenantId,
      conversationId,
      actorType,
      actorId,
      action,
      oldValue,
      newValue,
      metadata = {},
      description = null,
    } = params;
    try {
      const activity = await this.activityRepo.create({
        tenantId: tenantId ?? undefined,
        conversationId,
        actorType,
        actorId,
        action,
        oldValue,
        newValue,
        metadata,
        description,
      } as any);
      this.logger.debug(`Activity logged: ${action} on ${conversationId}`);

      // Emit for real-time WebSocket broadcast
      this.eventEmitter.emit('omni.activity.created', {
        tenantId,
        conversationId,
        activity,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to log activity: ${msg}`);
    }
  }

  /**
   * Resolve a user/agent ID to a display name.
   * Falls back to "Agent" if user cannot be found.
   */
  private async resolveActorName(
    actorId: string | null | undefined,
  ): Promise<string> {
    if (!actorId) return 'Hệ thống';
    try {
      const users = await this.usersService.findByIdsGlobal([actorId]);
      if (users.length > 0) {
        const u = users[0];
        const fullName = [u.firstName, u.lastName]
          .filter(Boolean)
          .join(' ')
          .trim();
        if (fullName && u.email) return `${fullName} (${u.email})`;
        return (fullName || u.email) ?? 'Agent';
      }
    } catch {
      // Fallback silently
    }
    return 'Agent';
  }

  /**
   * Resolve a group ID to a display name.
   * Falls back to "Nhóm" if group cannot be found.
   */
  private async resolveGroupName(
    groupId: string | null | undefined,
  ): Promise<string> {
    if (!groupId) return 'Nhóm';
    try {
      const group = await this.groupModel.findById(groupId).lean().exec();
      if (group) {
        return (group as any).name || 'Nhóm';
      }
    } catch {
      // Fallback silently
    }
    return 'Nhóm';
  }

  /** Map channel type to human-readable Vietnamese label */
  private channelLabel(type: string): string {
    const map: Record<string, string> = {
      facebook: 'Facebook Messenger',
      zalo: 'Zalo OA',
      whatsapp: 'WhatsApp',
      instagram: 'Instagram',
      livechat: 'Live Chat',
    };
    return map[type?.toLowerCase()] ?? type;
  }

  /** Map conversation status to Vietnamese verb */
  private statusLabel(status: string): string {
    const map: Record<string, string> = {
      resolved: 'resolve',
      closed: 'đóng',
      open: 'mở lại',
      pending: 'đặt chờ',
    };
    return map[status] ?? status;
  }

  /** Map assignment strategy to Vietnamese label */
  private strategyLabel(strategy: string): string {
    const map: Record<string, string> = {
      'round-robin': 'Round-Robin',
      'least-busy': 'Least-Busy',
      'capacity-based': 'Capacity-Based',
      sticky: 'Sticky Routing',
      manual: 'thủ công',
      bot_handoff: 'Bot Handoff',
    };
    return map[strategy] ?? strategy;
  }

  /** Humanize reason codes */
  private humanizeReason(reason: string): string {
    const map: Record<string, string> = {
      customer_replied_within_reopen_window:
        'khách hàng trả lời trong cửa sổ mở lại',
      auto_resolve_idle: 'không hoạt động quá thời gian quy định',
      sla_breach: 'vi phạm SLA',
    };
    return map[reason] ?? reason.replace(/_/g, ' ');
  }

  private buildActorPrefix(
    isManual: boolean,
    isAutoRoutingRule: boolean,
    performerName: string | null,
    strategy?: string,
  ): string {
    if (isManual) return `${performerName}`;
    if (isAutoRoutingRule) {
      const strategyText = strategy
        ? ` (luật: ${this.strategyLabel(strategy)})`
        : '';
      return `Hệ thống routing${strategyText}`;
    }
    return `Hệ thống`;
  }

  private async handleAgentAssignment(
    event: any,
    ctx: {
      isManual: boolean;
      performerName: string | null;
      actorPrefix: string;
    },
  ) {
    const {
      tenantId,
      conversationId,
      agentId,
      oldAgentId,
      strategy,
      reason,
      performedByUserId,
    } = event;
    const { isManual, performerName, actorPrefix } = ctx;

    if (agentId === undefined || agentId === oldAgentId) return;

    if (agentId) {
      const agentName = await this.resolveActorName(agentId);
      await this.log({
        tenantId,
        conversationId,
        actorType: isManual ? 'agent' : 'system',
        actorId: performedByUserId ?? agentId,
        action: 'agent_assigned',
        oldValue: oldAgentId,
        newValue: agentId,
        metadata: {
          strategy,
          reason,
          agentName,
          performedByUserId,
          performerName,
        },
        description: `${actorPrefix} đã phân công hội thoại cho tư vấn viên ${agentName}`,
      });
    } else if (oldAgentId) {
      const oldAgentName = await this.resolveActorName(oldAgentId);
      await this.log({
        tenantId,
        conversationId,
        actorType: isManual ? 'agent' : 'system',
        actorId: performedByUserId ?? oldAgentId,
        action: 'agent_unassigned',
        oldValue: oldAgentId,
        newValue: null,
        metadata: {
          reason,
          performedByUserId,
          performerName,
        },
        description: `${actorPrefix} đã gỡ tư vấn viên ${oldAgentName} khỏi hội thoại — chuyển về hàng chờ`,
      });
    }
  }

  private async handleGroupAssignment(
    event: any,
    ctx: {
      isManual: boolean;
      performerName: string | null;
      actorPrefix: string;
    },
  ) {
    const { tenantId, conversationId, groupId, oldGroupId, performedByUserId } =
      event;
    const { isManual, performerName, actorPrefix } = ctx;

    if (groupId === undefined) return;

    if (groupId) {
      const groupName = await this.resolveGroupName(groupId);
      this.logger.debug(
        `[onAssigned] logging group_assigned for ${groupId} → ${groupName}`,
      );
      await this.log({
        tenantId,
        conversationId,
        actorType: isManual ? 'agent' : 'system',
        actorId: performedByUserId ?? null,
        action: 'group_assigned',
        oldValue: oldGroupId ?? null,
        newValue: groupId,
        metadata: {
          groupId,
          groupName,
          performedByUserId,
          performerName,
        },
        description: `${actorPrefix} đã phân công hội thoại cho nhóm ${groupName}`,
      });
    } else if (oldGroupId) {
      const oldGroupName = await this.resolveGroupName(oldGroupId);
      await this.log({
        tenantId,
        conversationId,
        actorType: isManual ? 'agent' : 'system',
        actorId: performedByUserId ?? null,
        action: 'group_unassigned',
        oldValue: oldGroupId,
        newValue: null,
        metadata: {
          groupId: null,
          groupName: oldGroupName,
          performedByUserId,
          performerName,
        },
        description: `${actorPrefix} đã gỡ nhóm ${oldGroupName} khỏi hội thoại`,
      });
    }
  }
}
