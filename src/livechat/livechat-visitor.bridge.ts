import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { LivechatGateway } from './livechat.gateway';
import { ConversationRepository } from '../omni-inbound/repositories/conversation.repository';
import { UsersService } from '../users/users.service';
import { FilesService } from '../files/files.service';
import { MessageStatusService } from './services/message-status.service';
import { runWithTenantContext } from '../common/tenancy/tenant-context';

/**
 * LivechatVisitorBridge — bridges agent-side events đến visitor WebSocket.
 *
 * Không cần VisitorSession. Livechat giống mọi channel omni khác:
 *   OmniConversation.externalId = visitorId
 *
 * Events handled:
 *  - omni.conversation.assigned     → notifyAgentJoined (visitor thấy "Agent X đã tham gia")
 *  - omni.agent.typing.livechat     → sendTypingIndicator đến visitor
 *  - omni.conversation.status_changed (resolved) → thông báo visitor cuộc hội thoại kết thúc
 *  - livechat.agent.read            → push read receipt đến visitor widget
 */
@Injectable()
export class LivechatVisitorBridge {
  private readonly logger = new Logger(LivechatVisitorBridge.name);

  constructor(
    private readonly livechatGateway: LivechatGateway,
    private readonly conversationRepo: ConversationRepository,
    private readonly usersService: UsersService,
    private readonly filesService: FilesService,
    private readonly messageStatusService: MessageStatusService,
    private readonly cls: ClsService,
  ) {}

  // ── Assignment: notify visitor khi agent join ───────────────────────────

  /**
   * Khi conversation được assign (auto hoặc manual), resolve visitorId từ
   * OmniConversation.externalId và emit 'agent:joined' đến visitor room.
   */
  @OnEvent('omni.conversation.assigned')
  async handleAssignment(event: {
    tenantId: string;
    conversationId: string;
    agentId: string | null;
    oldAgentId?: string | null;
  }): Promise<void> {
    if (!event.agentId) return; // unassignment

    try {
      const conv = await runWithTenantContext(this.cls, event.tenantId, () =>
        this.conversationRepo.findById(event.conversationId),
      );
      if (!conv || conv.channelType !== 'livechat') return; // không phải livechat

      const visitorId = conv.externalConversationId; // externalConversationId = visitorId for livechat

      // Resolve agent display name and avatar
      let agentName = 'Support Agent';
      let agentAvatarUrl: string | null = null;

      try {
        const agent = await this.usersService.findById(event.agentId);
        if (agent) {
          agentName =
            [agent.firstName, agent.lastName]
              .filter(Boolean)
              .join(' ')
              .trim() ||
            agent.email ||
            'Support Agent';

          // FIX: Use typed `agent.photo` field (FileType | null) instead of
          // chained `as any` guesses. If photo has a path, generate a presigned URL.
          if (agent.photo?.path) {
            try {
              agentAvatarUrl = await this.filesService.getPresignedDownloadUrl(
                agent.photo.path,
                3600, // 1h TTL
              );
            } catch {
              // Non-fatal: fall through to null
            }
          }
        }
      } catch {
        /* use fallback */
      }

      this.logger.log(
        `[Bridge] Notify visitor ${visitorId} — agent "${agentName}" assigned to ${event.conversationId}`,
      );

      await this.livechatGateway.notifyAgentJoined(
        visitorId,
        agentName,
        agentAvatarUrl,
      );
    } catch (err: any) {
      this.logger.error(
        `[Bridge] handleAssignment failed for ${event.conversationId}: ${err?.message}`,
      );
    }
  }

  // ── Typing: agent → visitor ─────────────────────────────────────────────

  /**
   * OmniGateway emit event này khi agent gõ trong livechat conversation.
   * Bridge lookup visitorId từ OmniConversation.externalId.
   */
  @OnEvent('omni.agent.typing.livechat')
  async handleAgentTyping(event: {
    tenantId: string;
    conversationId: string;
    visitorId: string | null; // null khi emit từ OmniGateway
    isTyping: boolean;
    agentName?: string;
  }): Promise<void> {
    try {
      let visitorId = event.visitorId;

      // Nếu không có visitorId (emit từ OmniGateway), lookup từ conversation
      if (!visitorId) {
        if (!event.tenantId) {
          this.logger.warn(
            '[Bridge] handleAgentTyping: no tenantId in event, cannot resolve visitorId',
          );
          return;
        }
        const conv = await runWithTenantContext(this.cls, event.tenantId, () =>
          this.conversationRepo.findById(event.conversationId),
        );
        if (!conv) {
          this.logger.debug(
            `[Bridge] handleAgentTyping: conversation ${event.conversationId} not found, skipping`,
          );
          return;
        }
        if (conv.channelType !== 'livechat') return; // silently skip non-livechat
        visitorId = conv.externalConversationId;
      }

      if (!visitorId) {
        this.logger.warn(
          `[Bridge] handleAgentTyping: could not resolve visitorId for conversation ${event.conversationId}`,
        );
        return;
      }

      this.logger.debug(
        `[Bridge] Agent typing=${event.isTyping} → visitor ${visitorId}`,
      );

      this.livechatGateway.sendTypingIndicator(visitorId, event.isTyping);
    } catch (err: any) {
      this.logger.error(
        `[Bridge] handleAgentTyping failed for ${event.conversationId}: ${err?.message}`,
      );
    }
  }

  // ── Conversation ended: notify visitor ─────────────────────────────────

  /**
   * FIX: OmniController already includes `externalConversationId` in the
   * status_changed payload (omni.controller.ts line 861), so we don't need
   * to make a second DB round-trip to resolve visitorId.
   */
  @OnEvent('omni.conversation.status_changed')
  async handleStatusChanged(event: {
    tenantId: string;
    conversationId: string;
    status: string;
    channelType: string;
    externalConversationId?: string; // = visitorId for livechat (added by OmniController)
  }): Promise<void> {
    if (event.channelType !== 'livechat') return;
    if (event.status !== 'resolved' && event.status !== 'closed') return;

    try {
      // FIX: Prefer visitorId from event payload — avoids unnecessary DB query.
      const visitorId =
        event.externalConversationId ??
        (
          await runWithTenantContext(this.cls, event.tenantId, () =>
            this.conversationRepo.findById(event.conversationId),
          )
        )?.externalConversationId;

      if (!visitorId) return;

      await this.livechatGateway.sendToVisitor(visitorId, {
        type: 'text',
        content: '__conversation_ended__',
      });

      this.logger.log(
        `[Bridge] Notified visitor ${visitorId} — conversation ${event.conversationId} ended`,
      );
    } catch (err: any) {
      this.logger.error(
        `[Bridge] handleStatusChanged failed for ${event.conversationId}: ${err?.message}`,
      );
    }
  }

  // ── CSAT: push survey token to visitor widget ───────────────────────────

  /**
   * Task H: When CsatService generates a token (after conversation resolved),
   * push it directly to the visitor's socket room so the widget renders the
   * inline CSAT survey without requiring the visitor to follow an email link.
   *
   * Event is emitted by CsatService.handleConversationResolved().
   */
  @OnEvent('omni.csat.token_generated')
  async handleCsatTokenGenerated(event: {
    tenantId: string;
    conversationId: string;
    csatToken: string;
  }): Promise<void> {
    try {
      const conv = await runWithTenantContext(this.cls, event.tenantId, () =>
        this.conversationRepo.findById(event.conversationId),
      );
      if (!conv || conv.channelType !== 'livechat') return;

      const visitorId = conv.externalConversationId;
      if (!visitorId) return;

      this.livechatGateway.server
        ?.to(`visitor:${visitorId}`)
        .emit('csat:token', {
          token: event.csatToken,
          conversationId: event.conversationId,
        });

      this.logger.log(
        `[Bridge] CSAT token pushed to visitor ${visitorId} for conv ${event.conversationId}`,
      );
    } catch (err: any) {
      this.logger.error(
        `[Bridge] handleCsatTokenGenerated failed for ${event.conversationId}: ${err?.message}`,
      );
    }
  }

  // ── Agent read: push read receipt to visitor widget ──────────────────────

  /**
   * When the agent opens/views a livechat conversation (markAsRead),
   * mark all inbound (visitor → agent) messages as 'read' in DB,
   * then push the status update to the visitor widget so they see blue ticks.
   *
   * Event payload comes from OmniController.markAsRead().
   */
  @OnEvent('livechat.agent.read')
  async handleAgentRead(event: {
    tenantId: string;
    conversationId: string;
    externalConversationId?: string; // = visitorId for livechat
  }): Promise<void> {
    try {
      // Mark visitor messages as read in DB
      const updatedIds = await runWithTenantContext(
        this.cls,
        event.tenantId,
        () =>
          this.messageStatusService.markReadByAgent(
            event.tenantId,
            event.conversationId,
          ),
      );

      if (updatedIds.length === 0) return; // Nothing to notify

      // Resolve visitorId — prefer from event payload to avoid DB roundtrip
      const visitorId =
        event.externalConversationId ??
        (
          await runWithTenantContext(this.cls, event.tenantId, () =>
            this.conversationRepo.findById(event.conversationId),
          )
        )?.externalConversationId;

      if (!visitorId) return;

      // Push read receipt to visitor widget.
      // Use markAll=true because the widget only has local random IDs for visitor
      // messages — it cannot match MongoDB ObjectIds. Since markReadByAgent() marks
      // ALL unread visitor messages in this conversation, markAll is semantically correct.
      this.livechatGateway.sendStatusToVisitor(visitorId, {
        messageIds: updatedIds,
        status: 'read',
        markAll: true,
      });

      this.logger.log(
        `[Bridge] Agent read: pushed read receipt for ${updatedIds.length} message(s) ` +
          `to visitor ${visitorId} (conv ${event.conversationId})`,
      );
    } catch (err: any) {
      this.logger.error(
        `[Bridge] handleAgentRead failed for ${event.conversationId}: ${err?.message}`,
      );
    }
  }
}
