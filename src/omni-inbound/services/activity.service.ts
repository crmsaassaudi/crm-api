import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  ActivityRepository,
  ConversationActivity,
} from '../repositories/activity.repository';
import { PaginationResponseDto } from '../../utils/dto/pagination-response.dto';
import { UsersService } from '../../users/users.service';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { OmniEvents } from '../domain/omni-events';

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
    await this.log(
      event.tenantId,
      event.conversationId,
      'system',
      null,
      'conversation_created',
      null,
      'open',
      { channelType: event.channelType, senderId: event.senderId },
      `Cuộc hội thoại mới từ kênh ${channelLabel}`,
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
      `Khách hàng quay lại — cuộc hội thoại được mở lại (lần thứ ${event.reopenCount})`,
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
    resolveSource?: string;
  }) {
    // If auto-resolved by the system, use a separate action
    if (event.resolveSource === 'auto' || event.resolveSource === 'system') {
      const reasonText = event.reason
        ? ` (${this.humanizeReason(event.reason)})`
        : '';
      await this.log(
        event.tenantId,
        event.conversationId,
        'system',
        null,
        'auto_resolved',
        event.oldStatus,
        event.status,
        { reason: event.reason, resolveSource: event.resolveSource },
        `Hệ thống đã tự động resolve cuộc hội thoại${reasonText}`,
      );
      return;
    }

    const actorName = await this.resolveActorName(event.agentId);
    const statusLabel = this.statusLabel(event.status);
    const reasonText = event.reason
      ? ` (${this.humanizeReason(event.reason)})`
      : '';

    await this.log(
      event.tenantId,
      event.conversationId,
      'agent',
      event.agentId,
      'status_changed',
      event.oldStatus,
      event.status,
      { reason: event.reason, resolveSource: event.resolveSource },
      `${actorName} đã ${statusLabel} cuộc hội thoại${reasonText}`,
    );
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
    /** The user who triggered this via REST API — null means system/auto-routing */
    performedByUserId?: string | null;
  }) {
    this.logger.debug(
      `[onAssigned] event received: agentId=${event.agentId}, oldAgentId=${event.oldAgentId}, ` +
        `groupId=${event.groupId}, oldGroupId=${event.oldGroupId}, performedBy=${event.performedByUserId}`,
    );

    // Resolve who performed the action
    const isManual = !!event.performedByUserId && !event.strategy;
    const isAutoRoutingRule = !!event.strategy;
    const performerName = event.performedByUserId
      ? await this.resolveActorName(event.performedByUserId)
      : null;

    const strategyText = event.strategy
      ? ` (luật: ${this.strategyLabel(event.strategy)})`
      : '';

    // Prefix: who/what did the assignment
    const actorPrefix = isManual
      ? `${performerName}` // "Nguyễn Văn A"
      : isAutoRoutingRule
        ? `Hệ thống routing${strategyText}` // "Hệ thống routing (luật: round-robin)"
        : `Hệ thống`; // fallback

    // ── Agent assignment activity ─────────────────────────────────
    if (event.agentId !== undefined && event.agentId !== event.oldAgentId) {
      if (event.agentId) {
        const agentName = await this.resolveActorName(event.agentId);
        await this.log(
          event.tenantId,
          event.conversationId,
          isManual ? 'agent' : 'system',
          event.performedByUserId ?? event.agentId,
          'agent_assigned',
          event.oldAgentId,
          event.agentId,
          {
            strategy: event.strategy,
            reason: event.reason,
            agentName,
            performedByUserId: event.performedByUserId,
            performerName,
          },
          `${actorPrefix} đã phân công hội thoại cho tư vấn viên ${agentName}`,
        );
      } else if (event.oldAgentId) {
        const oldAgentName = await this.resolveActorName(event.oldAgentId);
        await this.log(
          event.tenantId,
          event.conversationId,
          isManual ? 'agent' : 'system',
          event.performedByUserId ?? event.oldAgentId,
          'agent_unassigned',
          event.oldAgentId,
          null,
          {
            reason: event.reason,
            performedByUserId: event.performedByUserId,
            performerName,
          },
          `${actorPrefix} đã gỡ tư vấn viên ${oldAgentName} khỏi hội thoại — chuyển về hàng chờ`,
        );
      }
    }

    // ── Group assignment activity ─────────────────────────────────
    if (event.groupId !== undefined) {
      if (event.groupId) {
        const groupName = await this.resolveGroupName(event.groupId);
        this.logger.debug(
          `[onAssigned] logging group_assigned for ${event.groupId} → ${groupName}`,
        );
        await this.log(
          event.tenantId,
          event.conversationId,
          isManual ? 'agent' : 'system',
          event.performedByUserId ?? null,
          'group_assigned',
          event.oldGroupId ?? null,
          event.groupId,
          {
            groupId: event.groupId,
            groupName,
            performedByUserId: event.performedByUserId,
            performerName,
          },
          `${actorPrefix} đã phân công hội thoại cho nhóm ${groupName}`,
        );
      } else {
        const oldGroupName = event.oldGroupId
          ? await this.resolveGroupName(event.oldGroupId)
          : 'nhóm';
        this.logger.debug(
          `[onAssigned] logging group_unassigned, oldGroup=${event.oldGroupId}`,
        );
        await this.log(
          event.tenantId,
          event.conversationId,
          isManual ? 'agent' : 'system',
          event.performedByUserId ?? null,
          'group_unassigned',
          event.oldGroupId ?? null,
          null,
          {},
          `Đã gỡ ${oldGroupName} khỏi hội thoại`,
        );
      }
    }
  }

  @OnEvent('omni.conversation.tag_added')
  async onTagAdded(event: {
    tenantId: string;
    conversationId: string;
    tag: string;
    agentId: string;
  }) {
    const actorName = await this.resolveActorName(event.agentId);
    await this.log(
      event.tenantId,
      event.conversationId,
      'agent',
      event.agentId,
      'tag_added',
      null,
      event.tag,
      {},
      `${actorName} đã thêm thẻ "${event.tag}"`,
    );
  }

  @OnEvent('omni.conversation.tag_removed')
  async onTagRemoved(event: {
    tenantId: string;
    conversationId: string;
    tag: string;
    agentId: string;
  }) {
    const actorName = await this.resolveActorName(event.agentId);
    await this.log(
      event.tenantId,
      event.conversationId,
      'agent',
      event.agentId,
      'tag_removed',
      event.tag,
      null,
      {},
      `${actorName} đã gỡ thẻ "${event.tag}"`,
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
    const actorName = await this.resolveActorName(event.authorId);
    const visibility = event.isPrivate ? 'nội bộ' : 'công khai';
    await this.log(
      event.tenantId,
      event.conversationId,
      'agent',
      event.authorId,
      'note_added',
      null,
      event.noteId,
      { content: event.content, isPrivate: event.isPrivate },
      `${actorName} đã thêm ghi chú ${visibility}`,
    );
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
    await this.log(
      event.tenantId,
      event.conversationId,
      'system',
      null,
      'sla_breached',
      null,
      event.slaType,
      { deadline: event.deadline, slaType: event.slaType },
      `⚠️ Vi phạm SLA: ${slaLabel} đã quá hạn`,
    );
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
    await this.log(
      event.tenantId,
      event.conversationId,
      'system',
      null,
      'escalated',
      null,
      String(event.level),
      {
        level: event.level,
        escalatedTo: event.escalatedTo,
        reason: event.reason,
      },
      `Cuộc hội thoại đã được leo thang (cấp ${event.level}) tới ${targetName}`,
    );
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
    await this.log(
      event.tenantId,
      event.conversationId,
      'agent',
      event.agentId,
      'ticket_created',
      null,
      event.ticketId,
      { ticketId: event.ticketId, subject: event.subject },
      `${actorName} đã tạo Ticket: "${event.subject}"`,
    );
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
    await this.log(
      event.tenantId,
      event.conversationId,
      'agent',
      event.agentId,
      'deal_created',
      null,
      event.dealId,
      { dealId: event.dealId, title: event.title },
      `${actorName} đã tạo Deal: "${event.title}"`,
    );
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
    await this.log(
      event.tenantId,
      event.conversationId,
      'system',
      null,
      'identity_merged',
      null,
      event.existingContactId,
      {
        existingContactId: event.existingContactId,
        senderId: event.senderId,
        channelType: event.channelType,
        matchedBy: event.matchedBy,
      },
      `Hệ thống đã tự động liên kết danh tính ${channelLabel} với hồ sơ khách hàng (khớp ${event.matchedBy})`,
    );
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

    await this.log(
      event.tenantId,
      event.conversationId,
      'agent',
      event.newAgentId,
      'conversation_takeover',
      event.previousAgentId,
      event.newAgentId,
      {
        previousAgentId: event.previousAgentId,
        previousAgentName,
        newAgentId: event.newAgentId,
        newAgentName,
        reason: event.reason,
        force: event.force,
        lockExpiresAt: event.lockExpiresAt,
      },
      `${newAgentName} đã tiếp quản hội thoại từ ${previousAgentName}${reasonText}`,
    );
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
    await this.log(
      event.tenantId,
      event.conversationId,
      'system',
      null,
      'status_changed',
      null,
      'queued',
      {
        strategy: event.strategy,
        reason: event.reason,
        channelType: event.channelType,
        agentPoolSize: event.agentPoolSize,
      },
      `Hội thoại đang chờ phân công (${event.strategy}) — ${event.reason}`,
    );
  }

  @OnEvent(OmniEvents.BOT_HANDOFF)
  async onBotHandoff(event: {
    tenantId: string;
    conversationId: string;
    channelType: string;
    channelAccount: string;
    contactId: string | null;
  }) {
    await this.log(
      event.tenantId,
      event.conversationId,
      'system',
      null,
      'bot_handoff',
      'active',
      'handoff',
      {
        channelType: event.channelType,
        channelAccount: event.channelAccount,
        contactId: event.contactId,
      },
      'Bot đã hoàn tất flow và chuyển hội thoại cho tư vấn viên',
    );
  }

  // ─── Helpers ────────────────────────────────────────────────────

  private async log(
    tenantId: string | null,
    conversationId: string,
    actorType: string,
    actorId: string | null,
    action: string,
    oldValue: string | null,
    newValue: string | null,
    metadata: Record<string, any> = {},
    description: string | null = null,
  ): Promise<void> {
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
        return fullName || u.email || 'Agent';
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
}
