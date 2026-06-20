import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { LivechatGateway } from './livechat.gateway';
import { ConversationRepository } from '../omni-inbound/repositories/conversation.repository';
import { UsersService } from '../users/users.service';
import { FilesService } from '../files/files.service';

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
 */
@Injectable()
export class LivechatVisitorBridge {
  private readonly logger = new Logger(LivechatVisitorBridge.name);

  constructor(
    private readonly livechatGateway: LivechatGateway,
    private readonly conversationRepo: ConversationRepository,
    private readonly usersService: UsersService,
    private readonly filesService: FilesService,
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
      const conv = await this.conversationRepo.findById(event.conversationId);
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
    conversationId: string;
    visitorId: string | null; // null khi emit từ OmniGateway
    isTyping: boolean;
    agentName?: string;
  }): Promise<void> {
    try {
      let visitorId = event.visitorId;

      // Nếu không có visitorId (emit từ OmniGateway), lookup từ conversation
      if (!visitorId) {
        const conv = await this.conversationRepo.findById(event.conversationId);
        if (!conv || conv.channelType !== 'livechat') return;
        visitorId = conv.externalConversationId;
      }

      this.logger.debug(
        `[Bridge] Agent typing=${event.isTyping} → visitor ${visitorId}`,
      );

      await this.livechatGateway.sendTypingIndicator(
        visitorId as string,
        event.isTyping,
      );
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
        (await this.conversationRepo.findById(event.conversationId))
          ?.externalConversationId;

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
      const conv = await this.conversationRepo.findById(event.conversationId);
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
}
