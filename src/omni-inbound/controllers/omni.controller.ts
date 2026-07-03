import {
  Controller,
  Get,
  Patch,
  Post,
  Delete,
  Param,
  Query,
  Body,
  HttpCode,
  HttpStatus,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Throttle } from '@nestjs/throttler';
import { ConversationRepository } from '../repositories/conversation.repository';
import { MessageRepository } from '../repositories/message.repository';
import { OutboundService } from '../../omni-outbound/outbound.service';
import { NoteService } from '../services/note.service';
import { ActivityService } from '../services/activity.service';
import { ConversationService } from '../services/conversation.service';
import { ConversationQueryService } from '../services/conversation-query.service';
import { ConversionService } from '../services/conversion.service';
import { ConversationLockService } from '../services/conversation-lock.service';
import { TimelineQueryDto } from '../dto/timeline-query.dto';
import { LinkMessagesDto } from '../dto/link-messages.dto';
import { UsersService } from '../../users/users.service';
import { TenantsService } from '../../tenants/tenants.service';
import { FilesService } from '../../files/files.service';
import { RequirePermission } from '../../common/permissions';
import { AssignmentAuditLogRepository } from '../repositories/omni-assignment-audit-log.repository';
import { AgentPresenceService } from '../services/agent-presence.service';
import { AssignmentService } from '../services/assignment.service';
import { ConversationCommandService } from '../aggregate/conversation-command.service';

/**
 * REST API for omni-channel conversations and messages.
 *
 * Endpoints:
 *   GET   /omni/conversations              — paginated list
 *   GET   /omni/conversations/:id          — single conversation detail
 *   GET   /omni/conversations/:id/messages — paginated messages
 *   PATCH /omni/conversations/:id/status   — resolve / reopen session
 *   POST  /omni/conversations/:id/tags     — add tag
 *   PATCH /omni/conversations/:id/claim    — claim / assign agent
 *   PATCH /omni/conversations/:id/read     — mark as read (reset unread count)
 *   PATCH /omni/conversations/:id/assign   — assign / reassign agent
 *   PATCH /omni/conversations/:id/unassign — remove agent assignment
 */
@Controller({ path: 'omni', version: '1' })
export class OmniController {
  private readonly logger = new Logger(OmniController.name);

  constructor(
    private readonly conversationRepo: ConversationRepository,
    private readonly messageRepo: MessageRepository,
    private readonly conversationService: ConversationService,
    private readonly queryService: ConversationQueryService,
    private readonly conversionService: ConversionService,
    private readonly outboundService: OutboundService,
    private readonly noteService: NoteService,
    private readonly activityService: ActivityService,
    private readonly conversationLockService: ConversationLockService,
    private readonly cls: ClsService,
    private readonly eventEmitter: EventEmitter2,
    private readonly usersService: UsersService,
    private readonly tenantsService: TenantsService,
    private readonly filesService: FilesService,
    private readonly auditLogRepo: AssignmentAuditLogRepository,
    private readonly agentPresenceService: AgentPresenceService,
    private readonly assignmentService: AssignmentService,
    private readonly conversationCommandService: ConversationCommandService,
  ) {}

  // ─── Routing Trace (production debugging) ────────────────────

  /**
   * GET /omni/conversations/:id/routing-trace
   *
   * Returns the assignment audit log for a specific conversation.
   * Shows every routing decision (assign, queue, fail) in chronological
   * order — the primary tool for debugging routing issues in production
   * without reading logs or code.
   */
  @Get('conversations/:id/routing-trace')
  @RequirePermission('view', 'contacts')
  async getRoutingTrace(
    @Param('id') conversationId: string,
    @Query('limit') limit = '10',
    @Query('cursor') cursor?: string,
  ) {
    const tenantId = this.cls.get<string>('tenantId');
    if (!tenantId) {
      throw new BadRequestException('Tenant context not found');
    }

    const conversation = await this.conversationRepo.findById(conversationId);
    if (!conversation) {
      throw new NotFoundException(`Conversation ${conversationId} not found`);
    }

    const { entries, nextCursor } = await this.auditLogRepo.findByConversation(
      tenantId,
      conversationId,
      Math.min(parseInt(limit, 10), 50),
      cursor || undefined,
    );

    return {
      conversationId,
      entries,
      total: entries.length,
      nextCursor,
    };
  }

  /**
   * GET /omni/routing-history
   *
   * Global routing audit log search across all conversations.
   * Supports query filtering by conversationId (partial match),
   * outcome (assigned/queued/failed), and limit.
   *
   * Powers the global Routing History page for production debugging
   * when a customer reports an issue and you need to trace without
   * knowing the exact conversation.
   */
  @Get('routing-history')
  @RequirePermission('view', 'contacts')
  async getRoutingHistory(
    @Query('search') search?: string,
    @Query('outcome') outcome?: 'assigned' | 'queued' | 'failed',
    @Query('limit') limit = '50',
  ) {
    const tenantId = this.cls.get<string>('tenantId');
    if (!tenantId) {
      throw new BadRequestException('Tenant context not found');
    }

    const entries = await this.auditLogRepo.search(
      tenantId,
      {
        conversationId: search || undefined,
        outcome: outcome || undefined,
      },
      Math.min(parseInt(limit, 10), 100),
    );

    return {
      entries,
      total: entries.length,
    };
  }

  // ─── Conversations ────────────────────────────────────────────

  /**
   * List conversations for the current tenant, paginated.
   * Supports filtering by status, channelType, assignedAgent, and search.
   */
  @Get('conversations')
  @RequirePermission('view', 'contacts')
  async listConversations(
    @Query('cursor') cursor?: string,
    @Query('limit') limit = '20',
    @Query('status') status?: string,
    @Query('channels') channels?: string,
    @Query('assignedTo') assignedTo?: string,
    @Query('sla') sla?: string,
    @Query('tags') tags?: string,
    @Query('isVip') isVip?: string,
    @Query('hasUnread') hasUnread?: string,
    @Query('search') search?: string,
    @Query('contactId') contactId?: string,
    @Query('page') page?: string,
  ) {
    const tenantId = this.cls.get<string>('tenantId');
    const userId = this.cls.get<string>('userId');
    if (!tenantId) {
      throw new BadRequestException('Tenant context not found');
    }

    // ── contactId shortcut: return paginated conversations for a CRM contact ──
    if (contactId) {
      return this.conversationRepo.findByContactId(
        tenantId,
        contactId,
        page ? parseInt(page, 10) : 1,
        Math.min(parseInt(limit, 10), 50),
      );
    }

    const statusFilter = status ? status.split(',') : ['open', 'pending'];
    // Normalize channels to lowercase for case-insensitive matching
    const channelFilter = channels
      ? channels.split(',').map((ch) => ch.toLowerCase())
      : undefined;
    const slaFilter = sla ? sla.split(',') : undefined;
    const tagsFilter = tags ? tags.split(',') : undefined;

    let assignedAgent: string | null | undefined = undefined;
    let assignedGroup: string | null | undefined = undefined;
    let unassigned = false;

    if (assignedTo === 'me') {
      assignedAgent = userId;
    } else if (assignedTo === 'unassigned') {
      unassigned = true;
    } else if (assignedTo?.startsWith('group:')) {
      assignedGroup = assignedTo.substring(6);
    }

    const result = await this.conversationRepo.findCursorPaginated(
      {
        tenantId,
        status: statusFilter,
        channels: channelFilter,
        assignedAgent,
        assignedGroup,
        unassigned,
        sla: slaFilter,
        tags: tagsFilter,
        isVip: isVip === 'true' ? true : isVip === 'false' ? false : undefined,
        hasUnread:
          hasUnread === 'true'
            ? true
            : hasUnread === 'false'
              ? false
              : undefined,
        search,
        cursor,
      },
      parseInt(limit, 10), // cap will be applied in repo
    );

    // Resolve display-friendly resolver info for list cards (name/email),
    // so UI does not have to show raw IDs.
    // Batch both resolvedByAgentId and assignedAgentId into one user lookup.
    const resolverIds = Array.from(
      new Set(
        result.data
          .map((c) => c.resolvedByAgentId)
          .filter((id): id is string => Boolean(id)),
      ),
    );

    const assignedAgentIds = Array.from(
      new Set(
        result.data
          .map((c) => c.assignedAgentId)
          .filter((id): id is string => Boolean(id)),
      ),
    );

    const allAgentIds = Array.from(
      new Set([...resolverIds, ...assignedAgentIds]),
    );

    let agentMap = new Map<
      string,
      { name: string | null; email: string | null }
    >();
    if (allAgentIds.length > 0) {
      const users = await this.usersService.findByIdsGlobal(allAgentIds);
      agentMap = new Map(
        users.map((u) => {
          const fullName = [u.firstName, u.lastName]
            .filter(Boolean)
            .join(' ')
            .trim();
          return [
            String(u.id),
            { name: fullName || null, email: u.email ?? null },
          ];
        }),
      );
    }

    const enrichedData = result.data.map((c) => {
      const resolvedFromPopulate = c.resolvedByAgent
        ? {
            name:
              [c.resolvedByAgent.firstName, c.resolvedByAgent.lastName]
                .filter(Boolean)
                .join(' ')
                .trim() || null,
            email: c.resolvedByAgent.email ?? null,
          }
        : null;

      const resolvedFromMap = c.resolvedByAgentId
        ? (agentMap.get(c.resolvedByAgentId) ?? null)
        : null;

      const resolvedDisplay = resolvedFromPopulate ?? resolvedFromMap;

      const assignedDisplay = c.assignedAgentId
        ? (agentMap.get(c.assignedAgentId) ?? null)
        : null;

      // Destructure out populated Mongoose objects — frontend expects
      // string IDs only, not full user objects.
      const { assignedAgent: _aa, resolvedByAgent: _ra, ...rest } = c;

      return {
        ...rest,
        resolvedByAgentName: resolvedDisplay?.name ?? null,
        resolvedByAgentEmail: resolvedDisplay?.email ?? null,
        assignedAgentName: assignedDisplay?.name ?? null,
      };
    });

    this.logger.debug(`listConversations: found ${result.data.length} items`);
    return {
      ...result,
      data: enrichedData,
    };
  }

  // ─── Batch Messages (cross-module) ──────────────────────────────

  /**
   * Fetch messages by an array of IDs.
   * Used by Deal/Ticket detail pages to display linked chat messages.
   */
  @Get('messages/batch')
  @RequirePermission('view', 'contacts')
  async getMessagesBatch(@Query('ids') ids?: string) {
    if (!ids) {
      throw new BadRequestException('ids query parameter is required');
    }

    const idArray = ids.split(',').filter(Boolean).slice(0, 50);
    if (idArray.length === 0) {
      return { data: [] };
    }

    const messages = await this.messageRepo.findByIds(idArray);
    return { data: messages };
  }

  /**
   * Get a single conversation by ID (with customer info).
   */
  @Get('conversations/:id')
  @RequirePermission('view', 'contacts')
  async getConversation(@Param('id') id: string) {
    const conversation = await this.conversationRepo.findById(id);
    if (!conversation) {
      throw new NotFoundException(`Conversation ${id} not found`);
    }
    return conversation;
  }

  /**
   * Update customer info (name, email, phone) for a conversation.
   */
  @Patch('conversations/:id/customer')
  @RequirePermission('edit', 'contacts')
  @HttpCode(HttpStatus.OK)
  async updateCustomer(
    @Param('id') id: string,
    @Body() body: { name?: string; email?: string; phone?: string },
  ) {
    const updated = await this.conversationRepo.updateCustomerInfo(id, body);
    if (!updated) {
      throw new NotFoundException(`Conversation ${id} not found`);
    }

    const tenantId = this.cls.get<string>('tenantId');
    const agentId = this.cls.get<string>('userId');

    // Emit event to update UI via socket
    this.eventEmitter.emit('omni.conversation.customer_updated', {
      tenantId,
      conversationId: id,
      customer: updated.customer,
      agentId,
    });

    return updated;
  }

  // ─── Messages ─────────────────────────────────────────────────

  /**
   * Get paginated messages for a conversation.
   * Returns oldest-first for chat display.
   *
   * Enriches media messages that have `metadata.media.fileId` but no
   * `mediaUrl`/`mediaProxyUrl` (e.g. livechat agent-sent images) with
   * presigned S3 download URLs so the frontend can render them.
   */
  @Get('conversations/:id/messages')
  @RequirePermission('view', 'contacts')
  async getMessages(
    @Param('id') conversationId: string,
    @Query('page') page = '1',
    @Query('limit') limit = '50',
  ) {
    // Verify conversation exists
    const conversation = await this.conversationRepo.findById(conversationId);
    if (!conversation) {
      throw new NotFoundException(`Conversation ${conversationId} not found`);
    }

    const result = await this.messageRepo.findByConversation(
      conversationId,
      parseInt(page, 10),
      Math.min(parseInt(limit, 10), 100),
    );

    // Enrich media messages that have fileId but no resolved URL
    const enriched = await this.enrichMediaUrls(result.data);

    return { ...result, data: enriched };
  }

  @Get('conversations/:id/sync')
  @RequirePermission('view', 'contacts')
  async syncConversation(
    @Param('id') conversationId: string,
    @Query('afterVersion') afterVersion?: string,
    @Query('afterMessageId') afterMessageId?: string,
    @Query('afterCreatedAt') afterCreatedAt?: string,
  ) {
    const tenantId = this.cls.get<string>('tenantId');
    if (!tenantId) {
      throw new BadRequestException('Tenant context not found');
    }

    const conversation = await this.conversationRepo.findById(conversationId);
    if (!conversation) {
      throw new NotFoundException(`Conversation ${conversationId} not found`);
    }

    const cursorCreatedAt = afterCreatedAt ? new Date(afterCreatedAt) : null;
    const canDeltaSync =
      !!afterMessageId &&
      !!cursorCreatedAt &&
      !Number.isNaN(cursorCreatedAt.getTime());

    const messageResult = canDeltaSync
      ? await this.messageRepo.findByConversationIdWithCursor({
          conversationId,
          limit: 100,
          direction: 'future',
          cursor: {
            id: afterMessageId,
            createdAt: cursorCreatedAt,
          },
        })
      : await this.messageRepo.findByConversation(conversationId, 1, 100);
    const messages = messageResult.data;
    const hasMore =
      'hasMore' in messageResult
        ? messageResult.hasMore
        : messageResult.hasNextPage;

    // Enrich media messages with presigned URLs
    const enrichedMessages = await this.enrichMediaUrls(messages);

    return {
      mode: canDeltaSync ? 'delta' : 'snapshot',
      conversationId,
      afterVersion: afterVersion ? Number(afterVersion) : null,
      afterMessageId: afterMessageId ?? null,
      currentVersion: Date.now(),
      conversation,
      messages: enrichedMessages,
      hasMore,
      lock: await this.conversationLockService.getLock(
        tenantId,
        conversationId,
      ),
    };
  }

  @Post('conversations/batch-sync')
  @RequirePermission('view', 'contacts')
  @HttpCode(HttpStatus.OK)
  async batchSyncConversations(
    @Body()
    body: {
      conversationIds?: string[];
      lastUpdated?: string;
    },
  ) {
    const tenantId = this.cls.get<string>('tenantId');
    if (!tenantId) {
      throw new BadRequestException('Tenant context not found');
    }

    const conversationIds = Array.from(
      new Set((body.conversationIds ?? []).filter(Boolean)),
    ).slice(0, 50);

    if (conversationIds.length === 0) {
      return {
        conversations: [],
        serverTime: new Date().toISOString(),
      };
    }

    const lastUpdatedAt = body.lastUpdated ? new Date(body.lastUpdated) : null;
    const conversations = await this.conversationRepo.findByIds(
      tenantId,
      conversationIds,
    );

    return {
      conversations: conversations.map((conversation) => ({
        id: conversation.id,
        status: conversation.status,
        lastMessage: conversation.lastMessage,
        lastMessageAt: conversation.lastMessageAt,
        unreadCount: conversation.unreadCount,
        assignedAgentId: conversation.assignedAgentId,
        assignedGroupId: conversation.assignedGroupId,
        tags: conversation.tags,
        updatedAt: conversation.updatedAt,
        hasChangesSince:
          !!lastUpdatedAt &&
          !!conversation.updatedAt &&
          new Date(conversation.updatedAt).getTime() > lastUpdatedAt.getTime(),
      })),
      serverTime: new Date().toISOString(),
    };
  }

  @Get('conversations/:id/timeline')
  @RequirePermission('view', 'contacts')
  async getConversationTimeline(
    @Param('id') conversationId: string,
    @Query() query: TimelineQueryDto,
  ) {
    const tenantId = this.cls.get<string>('tenantId');
    if (!tenantId) {
      throw new BadRequestException('Tenant context not found');
    }

    return this.queryService.getConversationTimeline({
      tenantId,
      conversationId,
      query,
    });
  }

  /**
   * Get the full cross-conversation message history for a customer.
   *
   * Returns all messages from ALL past and current conversations for
   * the same customer thread (same externalId), oldest-first.
   * This gives agents full context regardless of how many sessions
   * were opened and closed.
   *
   * @param convPage  Which batch of past conversations to load (default: 1 = most recent past batch)
   * @param convLimit How many past conversations per batch (default 5 — a reasonable scroll chunk)
   * @param msgPage   Pagination within the selected conversation batch
   * @param limit     Messages per page
   */
  @Get('conversations/:id/history')
  @RequirePermission('view', 'contacts')
  async getConversationHistory(
    @Param('id') conversationId: string,
    @Query('convPage') convPage = '1',
    @Query('convLimit') convLimit = '5',
    @Query('page') page = '1',
    @Query('limit') limit = '50',
  ) {
    const tenantId = this.cls.get<string>('tenantId');
    const conversation = await this.conversationRepo.findById(conversationId);
    if (!conversation) {
      throw new NotFoundException(`Conversation ${conversationId} not found`);
    }

    // ── Step 1: Get the total count of past sessions for this customer ──────
    const allConversations = await this.conversationRepo.findAllByExternalId(
      tenantId,
      conversation.channelType,
      conversation.channelAccount!,
      conversation.externalConversationId,
    );

    // Exclude the current (active) conversation — it's loaded separately
    const pastConversations = allConversations.filter(
      (c) => c.id !== conversationId,
    );
    const totalConversations = pastConversations.length;

    // ── Step 2: Paginate the conversation set (newest-first batches) ─────────
    const cp = Math.max(1, parseInt(convPage, 10));
    const cl = Math.min(parseInt(convLimit, 10), 20);
    const start = (cp - 1) * cl; // newest past first → slice from the end
    const pagedConversations = pastConversations.slice(
      Math.max(0, totalConversations - start - cl),
      Math.max(0, totalConversations - start),
    );

    const conversationIds = pagedConversations.map((c) => c.id);

    // ── Step 3: Fetch messages for this slice only ───────────────────────────
    const messages =
      conversationIds.length > 0
        ? await this.messageRepo.findByConversationIds(
            conversationIds,
            parseInt(page, 10),
            Math.min(parseInt(limit, 10), 100),
          )
        : { data: [], total: 0, page: 1, limit: 50 };

    const resolverIds = Array.from(
      new Set(
        pagedConversations
          .map((c) => c.resolvedByAgentId)
          .filter((id): id is string => Boolean(id)),
      ),
    );

    let resolverMap = new Map<
      string,
      { name: string | null; email: string | null }
    >();
    if (resolverIds.length > 0) {
      const users = await this.usersService.findByIdsGlobal(resolverIds);
      resolverMap = new Map(
        users.map((u) => {
          const fullName = [u.firstName, u.lastName]
            .filter(Boolean)
            .join(' ')
            .trim();
          return [
            String(u.id),
            { name: fullName || null, email: u.email ?? null },
          ];
        }),
      );
    }

    // ── Step 4: Build session metadata ──────────────────────────────────────
    const sessions = pagedConversations.map((c) => {
      const resolvedFromPopulate = c.resolvedByAgent
        ? {
            name:
              [c.resolvedByAgent.firstName, c.resolvedByAgent.lastName]
                .filter(Boolean)
                .join(' ')
                .trim() || null,
            email: c.resolvedByAgent.email ?? null,
          }
        : null;

      const resolvedFromMap = c.resolvedByAgentId
        ? (resolverMap.get(c.resolvedByAgentId) ?? null)
        : null;

      const resolvedDisplay = resolvedFromPopulate ?? resolvedFromMap;

      return {
        id: c.id,
        status: c.status,
        createdAt: c.createdAt,
        resolvedAt: c.resolvedAt,
        resolvedByAgentId: c.resolvedByAgentId,
        resolveReason: c.resolveReason,
        resolveNote: c.resolveNote,
        resolveSource: c.resolveSource,
        lastMessage: c.lastMessage,
        resolvedByAgent: c.resolvedByAgent,
        resolvedByAgentName: resolvedDisplay?.name ?? null,
        resolvedByAgentEmail: resolvedDisplay?.email ?? null,
      };
    });

    return {
      ...messages,
      totalConversations,
      convPage: cp,
      convLimit: cl,
      hasMoreHistory: start + cl < totalConversations,
      sessions,
    };
  }

  @Post('conversations/:id/messages')
  // Per-tenant cap: 60 outbound messages / minute / user. Prevents one
  // agent (or compromised session) from spam-sending across providers
  // and tripping provider-side rate limits that would block the whole
  // tenant.
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @RequirePermission('edit', 'contacts')
  @HttpCode(HttpStatus.CREATED)
  async sendMessage(
    @Param('id') conversationId: string,
    @Body('content') content: string,
    @Body('messageType') messageType?: string,
    @Body('idempotencyKey') idempotencyKey?: string,
    @Body('clientMessageId') clientMessageId?: string,
    @Body('source') source?: string,
  ) {
    if (!content) {
      throw new BadRequestException('Content is required');
    }

    const tenantId = this.cls.get<string>('tenantId');
    const agentId = this.cls.get<string>('userId');

    if (!tenantId || !agentId) {
      throw new BadRequestException('User or Tenant context not found');
    }

    try {
      return await this.outboundService.sendAgentMessage({
        tenantId,
        conversationId,
        agentId,
        content,
        messageType,
        source: source ?? 'crm_api',
        transport: 'http',
        idempotencyKey,
        clientMessageId,
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Failed to send message: ${errorMessage}`);
      throw new BadRequestException(errorMessage);
    }
  }

  @Post('conversations/:id/email-reply')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @RequirePermission('edit', 'contacts')
  @HttpCode(HttpStatus.CREATED)
  async emailReply(
    @Param('id') conversationId: string,
    @Body()
    payload: {
      to: string[];
      cc?: string[];
      bcc?: string[];
      subject: string;
      htmlBody: string;
      inReplyTo?: string;
      references?: string[];
      attachments?: { url: string; filename: string; contentType: string }[];
    },
  ) {
    const tenantId = this.cls.get<string>('tenantId');
    const agentId = this.cls.get<string>('userId');

    if (!tenantId || !agentId) {
      throw new BadRequestException('User or Tenant context not found');
    }

    try {
      return await this.outboundService.sendEmailReply({
        tenantId,
        conversationId,
        agentId,
        ...payload,
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : typeof error === 'string'
            ? error
            : JSON.stringify(error);
      this.logger.error(`Failed to send email reply: ${message}`);
      throw new BadRequestException(message);
    }
  }

  /**
   * GET /omni/conversations/:id/reply-window
   * Returns the platform reply window status for this conversation.
   * The frontend uses this to lock/unlock the chat input.
   */
  @Get('conversations/:id/reply-window')
  @RequirePermission('view', 'contacts')
  async getReplyWindowStatus(@Param('id') conversationId: string) {
    const conversation = await this.conversationRepo.findById(conversationId);
    if (!conversation) {
      throw new NotFoundException(`Conversation ${conversationId} not found`);
    }

    return this.outboundService.getReplyWindowStatus(conversation);
  }

  @Get('conversations/:id/lock')
  @RequirePermission('view', 'contacts')
  async getConversationLock(@Param('id') conversationId: string) {
    const tenantId = this.cls.get<string>('tenantId');
    if (!tenantId) {
      throw new BadRequestException('Tenant context not found');
    }

    return {
      lock: await this.conversationLockService.getLock(
        tenantId,
        conversationId,
      ),
    };
  }

  @Post('conversations/:id/lock')
  @RequirePermission('edit', 'contacts')
  @HttpCode(HttpStatus.OK)
  async acquireConversationLock(
    @Param('id') conversationId: string,
    @Body('source') source?: string,
  ) {
    const tenantId = this.cls.get<string>('tenantId');
    const agentId = this.cls.get<string>('userId');
    if (!tenantId || !agentId) {
      throw new BadRequestException('User or Tenant context not found');
    }

    return this.conversationLockService.acquireLock({
      tenantId,
      conversationId,
      agentId,
      agentName: await this.resolveAgentName(agentId),
      source,
    });
  }

  @Post('conversations/:id/lock/heartbeat')
  @RequirePermission('edit', 'contacts')
  @HttpCode(HttpStatus.OK)
  async heartbeatConversationLock(@Param('id') conversationId: string) {
    const tenantId = this.cls.get<string>('tenantId');
    const agentId = this.cls.get<string>('userId');
    if (!tenantId || !agentId) {
      throw new BadRequestException('User or Tenant context not found');
    }

    return {
      lock: await this.conversationLockService.heartbeat({
        tenantId,
        conversationId,
        agentId,
        agentName: await this.resolveAgentName(agentId),
      }),
    };
  }

  @Delete('conversations/:id/lock')
  @RequirePermission('edit', 'contacts')
  @HttpCode(HttpStatus.OK)
  async releaseConversationLock(@Param('id') conversationId: string) {
    const tenantId = this.cls.get<string>('tenantId');
    const agentId = this.cls.get<string>('userId');
    if (!tenantId || !agentId) {
      throw new BadRequestException('User or Tenant context not found');
    }

    return {
      released: await this.conversationLockService.releaseLock({
        tenantId,
        conversationId,
        agentId,
      }),
    };
  }

  @Post('conversations/:id/takeover')
  @RequirePermission('edit', 'contacts')
  @HttpCode(HttpStatus.OK)
  async takeoverConversation(
    @Param('id') conversationId: string,
    @Body('reason') reason?: string,
    @Body('force') force?: boolean,
  ) {
    const tenantId = this.cls.get<string>('tenantId');
    const agentId = this.cls.get<string>('userId');
    if (!tenantId || !agentId) {
      throw new BadRequestException('User or Tenant context not found');
    }

    const conversation = await this.conversationRepo.findById(conversationId);
    if (!conversation) {
      throw new NotFoundException(`Conversation ${conversationId} not found`);
    }

    const result = await this.conversationLockService.takeover({
      tenantId,
      conversationId,
      newAgentId: agentId,
      newAgentName: await this.resolveAgentName(agentId),
      reason,
      force: force ?? false,
    });

    if (conversation.assignedAgentId !== agentId) {
      await this.conversationCommandService.executeAssignAgent(
        conversationId,
        tenantId,
        {
          agentId,
          previousAgentId: conversation.assignedAgentId,
          reason: 'takeover',
          performedByUserId: agentId,
        },
      );
    }

    return {
      conversationId,
      previousAgentId: result.previousLock?.agentId ?? null,
      newAgentId: agentId,
      lockExpiresAt: result.newLock.expiresAt,
    };
  }

  // ─── Session management ────────────────────────────────────────

  /**
   * Change conversation status (resolve, reopen, close).
   * When resolving or closing, captures agent ID, timestamp, and optional reason.
   * Emits `omni.conversation.status_changed` event for:
   *   - Identity cache invalidation (so next message creates new session)
   *   - Audit trail logging
   *   - WebSocket broadcast
   */
  @Patch('conversations/:id/status')
  @RequirePermission('edit', 'contacts')
  @HttpCode(HttpStatus.OK)
  async updateStatus(
    @Param('id') id: string,
    @Body('status') status: string,
    @Body('reason') reason?: string,
    @Body('note') note?: string,
    @Body('resolveSource') resolveSource?: string,
  ) {
    const validStatuses = ['open', 'pending', 'resolved', 'closed'];
    if (!validStatuses.includes(status)) {
      throw new BadRequestException(
        `Invalid status. Must be one of: ${validStatuses.join(', ')}`,
      );
    }

    const agentId = this.cls.get<string>('userId');

    // Look up conversation first to get channel info for cache invalidation
    const conversation = await this.conversationRepo.findById(id);
    if (!conversation) {
      throw new NotFoundException(`Conversation ${id} not found`);
    }

    const oldStatus = conversation.status;

    const updated = await this.conversationCommandService.executeChangeStatus(
      id,
      conversation.tenantId,
      {
        newStatus: status as any,
        oldStatus,
        agentId,
        reason,
        note,
        resolveSource: resolveSource ?? 'agent',
        channelType: conversation.channelType,
        channelAccount: conversation.channelAccount,
        externalConversationId: conversation.externalConversationId,
      },
    );

    this.logger.log(
      `Conversation ${id} status → ${status} (by ${resolveSource ?? 'agent'} ${agentId})`,
    );
    return updated;
  }

  /**
   * POST /omni/conversations/:id/snooze
   *
   * Temporarily suspends a conversation for a given number of minutes.
   * Sets status to 'pending' and stores a snoozeUntil timestamp on the
   * conversation. The conversation reopens automatically when:
   *   1. The customer sends a new message (handled in inbound flow), or
   *   2. A scheduled job polls and reopens past-deadline snoozed conversations.
   */
  @Post('conversations/:id/snooze')
  @RequirePermission('edit', 'contacts')
  @HttpCode(HttpStatus.OK)
  async snoozeConversation(
    @Param('id') id: string,
    @Body('minutes') minutes = 30,
  ) {
    const minutesNum = Number(minutes);
    if (!minutesNum || minutesNum < 1 || minutesNum > 10_080) {
      throw new BadRequestException(
        'minutes must be between 1 and 10080 (7 days)',
      );
    }

    const conversation = await this.conversationRepo.findById(id);
    if (!conversation) {
      throw new NotFoundException(`Conversation ${id} not found`);
    }

    const snoozeUntil = new Date(Date.now() + minutesNum * 60_000);

    const result = await this.conversationRepo.snoozeConversation(
      id,
      snoozeUntil,
    );
    if (!result) {
      throw new NotFoundException(`Conversation ${id} not found`);
    }

    this.logger.log(
      `Conversation ${id} snoozed for ${minutesNum}m until ${snoozeUntil.toISOString()}`,
    );

    return { id, status: 'pending', snoozeUntil };
  }

  /**
   * POST /omni/conversations/:id/bot/disable
   *
   * Manually disable the bot on this conversation (agent takeover).
   * Sets bot.enabled=false, bot.status='ended' and emits BOT_DISABLED event.
   */
  @Post('conversations/:id/bot/disable')
  @RequirePermission('edit', 'contacts')
  @HttpCode(HttpStatus.OK)
  async disableBotOnConversation(@Param('id') id: string) {
    const tenantId = this.cls.get<string>('tenantId');
    const agentId = this.cls.get<string>('userId');
    if (!tenantId || !agentId) {
      throw new BadRequestException('User or Tenant context not found');
    }

    const conversation = await this.conversationRepo.findById(id);
    if (!conversation) {
      throw new NotFoundException(`Conversation ${id} not found`);
    }

    const updated = await this.conversationCommandService.executeUpdateBotState(
      id,
      tenantId,
      {
        botState: { enabled: false, status: 'ended' },
        reason: 'agent_takeover',
        agentId,
      },
    );

    this.logger.log(
      `Bot disabled on conversation ${id} by agent ${agentId} (manual takeover)`,
    );

    return { ok: true, conversationId: id, botDisabled: true };
  }

  /**
   * POST /omni/conversations/:id/bot/enable
   *
   * Manually re-enable the bot on this conversation (undo agent takeover).
   * Sets bot.enabled=true, bot.status='active' and emits BOT_ENABLED event.
   */
  @Post('conversations/:id/bot/enable')
  @RequirePermission('edit', 'contacts')
  @HttpCode(HttpStatus.OK)
  async enableBotOnConversation(@Param('id') id: string) {
    const tenantId = this.cls.get<string>('tenantId');
    const agentId = this.cls.get<string>('userId');
    if (!tenantId || !agentId) {
      throw new BadRequestException('User or Tenant context not found');
    }

    const conversation = await this.conversationRepo.findById(id);
    if (!conversation) {
      throw new NotFoundException(`Conversation ${id} not found`);
    }

    const updated = await this.conversationCommandService.executeUpdateBotState(
      id,
      tenantId,
      {
        botState: { enabled: true, status: 'active' },
        reason: 'agent_reenable',
        agentId,
      },
    );

    this.logger.log(`Bot re-enabled on conversation ${id} by agent ${agentId}`);

    return { ok: true, conversationId: id, botDisabled: false };
  }

  @Post('conversations/:id/tags')
  @HttpCode(HttpStatus.OK)
  async addTag(@Param('id') id: string, @Body('tag') tag: string) {
    if (!tag || typeof tag !== 'string') {
      throw new BadRequestException('Tag is required');
    }

    // Fetch conversation first to check if tag already exists
    const conversation = await this.conversationRepo.findById(id);
    if (!conversation) {
      throw new NotFoundException(`Conversation ${id} not found`);
    }

    const normalizedTag = tag.trim();
    const alreadyTagged = conversation.tags?.includes(normalizedTag) ?? false;

    const updated = await this.conversationRepo.addTag(id, normalizedTag);
    if (!updated) {
      throw new NotFoundException(`Conversation ${id} not found`);
    }

    // Only emit event (and create activity log) if the tag is genuinely new
    if (!alreadyTagged) {
      const agentId = this.cls.get<string>('userId');
      const tenantId = this.cls.get<string>('tenantId');
      this.eventEmitter.emit('omni.conversation.tag_added', {
        tenantId,
        conversationId: id,
        tag: normalizedTag,
        agentId,
      });
    }

    return updated;
  }

  @Delete('conversations/:id/tags/:tag')
  @HttpCode(HttpStatus.OK)
  async removeTag(@Param('id') id: string, @Param('tag') tag: string) {
    const normalizedTag = decodeURIComponent(tag).trim();
    const updated = await this.conversationRepo.removeTag(id, normalizedTag);
    if (!updated) {
      throw new NotFoundException(`Conversation ${id} not found`);
    }

    const agentId = this.cls.get<string>('userId');
    const tenantId = this.cls.get<string>('tenantId');
    this.eventEmitter.emit('omni.conversation.tag_removed', {
      tenantId,
      conversationId: id,
      tag: normalizedTag,
      agentId,
    });

    return updated;
  }

  // ─── Claim / Assign ────────────────────────────────────────────

  @Patch('conversations/:id/claim')
  @HttpCode(HttpStatus.OK)
  async claimConversation(
    @Param('id') id: string,
    @Body('agentId') agentId: string,
  ) {
    if (!agentId) {
      throw new BadRequestException('agentId is required');
    }

    const updated = await this.conversationRepo.claimConversation(id, agentId);
    if (!updated) {
      throw new NotFoundException(`Conversation ${id} not found`);
    }

    this.logger.log(`Conversation ${id} claimed by agent ${agentId}`);
    return updated;
  }

  /**
   * Assign or reassign agent and/or group to a conversation.
   * Supports setting agentId or groupId to null to unassign.
   */
  @Patch('conversations/:id/assign')
  @HttpCode(HttpStatus.OK)
  async assignAgent(
    @Param('id') id: string,
    @Body('agentId') agentId?: string | null,
    @Body('groupId') groupId?: string | null,
  ) {
    // Only reject if neither field was provided at all (both undefined)
    if (agentId === undefined && groupId === undefined) {
      throw new BadRequestException('agentId or groupId is required');
    }

    const conversation = await this.conversationRepo.findById(id);
    if (!conversation) {
      throw new NotFoundException(`Conversation ${id} not found`);
    }

    const oldAgentId = conversation.assignedAgentId;
    const oldGroupId = conversation.assignedGroupId;
    // The user performing this assignment (from authenticated session via CLS)
    const performedByUserId = this.cls.get<string>('userId') ?? null;
    let updated: any = conversation;

    if (agentId !== undefined) {
      updated = await this.conversationCommandService.executeAssignAgent(
        id,
        conversation.tenantId,
        {
          agentId,
          groupId,
          previousAgentId: oldAgentId,
          previousGroupId: oldGroupId,
          reason: 'manual',
          performedByUserId,
          syncCapacity: {
            releaseAgentId: (oldAgentId && oldAgentId !== agentId) ? oldAgentId : undefined,
            assignAgentId: agentId ?? undefined,
          },
          auditLog: { channelType: conversation.channelType },
        },
      );

      this.logger.log(
        `Conversation ${id} assigned: agent=${agentId ?? 'unchanged'}, group=${groupId ?? 'unchanged'} by user=${performedByUserId}`,
      );
      return updated;
    }

    // Group-only assignment (no agent change)
    if (groupId !== undefined) {
      updated = await this.conversationRepo.updateGroupAssignment(id, groupId);

      this.eventEmitter.emit('omni.conversation.assigned', {
        tenantId: conversation.tenantId,
        conversationId: id,
        agentId: conversation.assignedAgentId,
        oldAgentId,
        groupId,
        oldGroupId,
        performedByUserId,
      });

      return updated;
    }
  }

  /**
   * Remove agent assignment from a conversation (back to queue).
   */
  @Patch('conversations/:id/unassign')
  @HttpCode(HttpStatus.OK)
  async unassignAgent(@Param('id') id: string) {
    const conversation = await this.conversationRepo.findById(id);
    if (!conversation) {
      throw new NotFoundException(`Conversation ${id} not found`);
    }

    const oldAgentId = conversation.assignedAgentId;
    const performedByUserId = this.cls.get<string>('userId') ?? null;

    const operationId = await this.conversationCommandService.executeAssignAgent(
      id,
      conversation.tenantId,
      {
        agentId: null,
        previousAgentId: oldAgentId,
        reason: 'manual_unassign',
        performedByUserId,
        syncCapacity: {
          releaseAgentId: oldAgentId ?? undefined,
        },
        auditLog: { channelType: conversation.channelType },
      },
    );

    this.logger.log(
      `Conversation ${id} unassigned by user=${performedByUserId}`,
    );
    return operationId;
  }

  // ─── Notes ──────────────────────────────────────────────────────

  @Post('conversations/:id/notes')
  @HttpCode(HttpStatus.CREATED)
  async createNote(
    @Param('id') conversationId: string,
    @Body('content') content: string,
    @Body('isPrivate') isPrivate?: boolean,
    @Body('mentions') mentions?: string[],
    @Body('isPinned') isPinned?: boolean,
  ) {
    if (!content) {
      throw new BadRequestException('Content is required');
    }

    const tenantId = this.cls.get<string>('tenantId');
    const agentId = this.cls.get<string>('userId');

    return this.noteService.createNote(
      tenantId,
      conversationId,
      agentId,
      content,
      isPrivate ?? true,
      mentions ?? [],
      isPinned ?? false,
    );
  }

  @Get('conversations/:id/notes')
  async getNotes(
    @Param('id') conversationId: string,
    @Query('page') page = '1',
    @Query('limit') limit = '20',
  ) {
    return this.noteService.getNotes(
      conversationId,
      parseInt(page, 10),
      Math.min(parseInt(limit, 10), 50),
    );
  }

  @Get('conversations/:id/notes/pinned')
  async getPinnedNote(@Param('id') conversationId: string) {
    const note = await this.noteService.getPinnedNote(conversationId);
    // Return empty object with null so frontend can handle gracefully
    return { data: note ?? null };
  }

  @Patch('conversations/:convId/notes/:noteId')
  @HttpCode(HttpStatus.OK)
  async updateNote(
    @Param('noteId') noteId: string,
    @Body('content') content: string,
    @Body('isPrivate') isPrivate?: boolean,
    @Body('isPinned') isPinned?: boolean,
  ) {
    if (!content) {
      throw new BadRequestException('Content is required');
    }

    const updated = await this.noteService.updateNote(
      noteId,
      content,
      isPrivate,
      isPinned,
    );
    if (!updated) {
      throw new NotFoundException(`Note ${noteId} not found`);
    }
    return updated;
  }

  @Delete('conversations/:convId/notes/:noteId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteNote(@Param('noteId') noteId: string) {
    const deleted = await this.noteService.deleteNote(noteId);
    if (!deleted) {
      throw new NotFoundException(`Note ${noteId} not found`);
    }
  }

  // ─── Read / Unread ─────────────────────────────────────────────

  // ─── Activities (Audit Trail) ───────────────────────────────────

  @Get('conversations/:id/activities')
  async getActivities(
    @Param('id') conversationId: string,
    @Query('page') page = '1',
    @Query('limit') limit = '50',
  ) {
    return this.activityService.getActivities(
      conversationId,
      parseInt(page, 10),
      Math.min(parseInt(limit, 10), 100),
    );
  }

  // ─── Read / Unread ─────────────────────────────────────────────

  @Patch('conversations/:id/read')
  @HttpCode(HttpStatus.NO_CONTENT)
  async markAsRead(@Param('id') id: string) {
    const conversation = await this.conversationRepo.findById(id);
    await this.conversationRepo.resetUnreadCount(id);

    // FIX: Broadcast unread count reset to all agents in the tenant room
    // so the conversation list sidebar updates in real-time for all tabs/agents.
    if (conversation?.tenantId) {
      this.eventEmitter.emit('omni.conversation.unread_reset', {
        tenantId: conversation.tenantId,
        conversationId: id,
      });
    }

    // Livechat: Mark all unread visitor messages as 'read' by agent
    // and push read receipt to visitor widget so they see blue ticks in real-time.
    if (conversation?.channelType === 'livechat') {
      this.eventEmitter.emit('livechat.agent.read', {
        tenantId: conversation.tenantId,
        conversationId: id,
        externalConversationId: conversation.externalConversationId,
      });
    }

    // Two-Way Read State Sync: trigger background IMAP \Seen flag update
    // for email conversations when the agent reads them in the CRM UI.
    // The sync worker checks the opt-in flag (syncReadState) before processing.
    if (conversation?.channelType === 'email') {
      this.eventEmitter.emit('email.read_state.changed', {
        tenantId: conversation.tenantId,
        conversationId: id,
        configId: conversation.channelAccount, // channelAccount = SMTP config ID
        targetState: 'read' as const,
      });
    }
  }

  // ─── Settings ─────────────────────────────────────────────────

  /** Default notification sound config used when tenant has none */
  private static readonly DEFAULT_NOTIFICATION_SOUND = {
    agent: { enabled: true, soundUrl: null, volume: 80 },
    visitor: { enabled: true, soundUrl: null, volume: 80 },
  };

  /**
   * GET /omni/settings
   * Returns current omni-channel settings for the tenant.
   */
  @Get('settings')
  async getSettings() {
    const tenantId = this.cls.get<string>('tenantId');
    if (!tenantId) throw new BadRequestException('Tenant context not found');
    const tenant = await this.tenantsService.findById(tenantId);
    const settings = tenant?.omniSettings ?? { resolveNoteMode: 'optional' };
    return {
      ...settings,
      notificationSound:
        settings.notificationSound ?? OmniController.DEFAULT_NOTIFICATION_SOUND,
    };
  }

  /**
   * PATCH /omni/settings
   * Updates omni-channel settings (resolveNoteMode and/or notificationSound).
   */
  @Patch('settings')
  async updateSettings(
    @Body('resolveNoteMode') resolveNoteMode?: string,
    @Body('notificationSound')
    notificationSound?: {
      agent?: { enabled?: boolean; soundUrl?: string | null; volume?: number };
      visitor?: {
        enabled?: boolean;
        soundUrl?: string | null;
        volume?: number;
      };
    },
  ) {
    const tenantId = this.cls.get<string>('tenantId');
    if (!tenantId) throw new BadRequestException('Tenant context not found');

    // Validate resolveNoteMode if provided
    if (resolveNoteMode !== undefined) {
      const validModes = ['disabled', 'optional', 'required'];
      if (!validModes.includes(resolveNoteMode)) {
        throw new BadRequestException(
          `resolveNoteMode must be one of: ${validModes.join(', ')}`,
        );
      }
    }

    // Validate volume ranges if provided
    const validateVolume = (v?: number) => {
      if (v !== undefined && (v < 0 || v > 100)) {
        throw new BadRequestException('volume must be between 0 and 100');
      }
    };
    validateVolume(notificationSound?.agent?.volume);
    validateVolume(notificationSound?.visitor?.volume);

    const payload: Record<string, any> = {};
    if (resolveNoteMode !== undefined) {
      payload.resolveNoteMode = resolveNoteMode;
    }
    if (notificationSound !== undefined) {
      payload.notificationSound = notificationSound;
    }

    if (Object.keys(payload).length === 0) {
      throw new BadRequestException('At least one setting field is required');
    }

    const updated = await this.tenantsService.updateOmniSettings(
      tenantId,
      payload,
    );
    return updated?.omniSettings ?? payload;
  }

  /**
   * GET /omni/settings/storage-quota
   * Returns the current tenant's storage usage and limit.
   */
  @Get('settings/storage-quota')
  async getStorageQuota() {
    const tenantId = this.cls.get<string>('tenantId');
    if (!tenantId) throw new BadRequestException('Tenant context not found');
    const result = await this.tenantsService.getStorageBreakdown(tenantId);
    return {
      ...result.quota,
      usedMB: Math.round(result.quota.usedBytes / (1024 * 1024)),
      limitMB:
        result.quota.limitBytes === -1
          ? -1
          : Math.round(result.quota.limitBytes / (1024 * 1024)),
      usagePercent:
        result.quota.limitBytes > 0 && result.quota.limitBytes !== -1
          ? Math.round((result.quota.usedBytes / result.quota.limitBytes) * 100)
          : 0,
      breakdown: result.breakdown,
    };
  }

  /**
   * PATCH /omni/settings/storage-quota
   * Update the tenant's storage limit (admin).
   * Accepts limitBytes or limitMB for backward compat.
   */
  @Patch('settings/storage-quota')
  async updateStorageQuota(
    @Body('limitBytes') limitBytes?: number,
    @Body('limitMB') limitMB?: number,
  ) {
    const tenantId = this.cls.get<string>('tenantId');
    if (!tenantId) throw new BadRequestException('Tenant context not found');

    // Support both limitBytes and limitMB (backward compat)
    let finalBytes: number;
    if (limitBytes !== undefined) {
      finalBytes = limitBytes;
    } else if (limitMB !== undefined) {
      finalBytes = limitMB === -1 ? -1 : limitMB * 1024 * 1024;
    } else {
      throw new BadRequestException('limitBytes or limitMB is required');
    }

    if (
      typeof finalBytes !== 'number' ||
      (finalBytes < 0 && finalBytes !== -1)
    ) {
      throw new BadRequestException(
        'Limit must be a positive number or -1 (unlimited)',
      );
    }

    await this.tenantsService.updateStorageQuota(tenantId, finalBytes);
    return {
      limitBytes: finalBytes,
      limitMB: finalBytes === -1 ? -1 : Math.round(finalBytes / (1024 * 1024)),
    };
  }

  // ─── Conversation File History ─────────────────────────────────

  /**
   * GET /omni/conversations/:id/files
   * List all files associated with a conversation.
   * Returns paginated list with presigned URLs (never exposes storageKey).
   */
  @Get('conversations/:id/files')
  @RequirePermission('view', 'contacts')
  async getConversationFiles(
    @Param('id') conversationId: string,
    @Query('type') type?: string,
    @Query('page') page = '1',
    @Query('limit') limit = '20',
  ) {
    const tenantId = this.cls.get<string>('tenantId');
    if (!tenantId) {
      throw new BadRequestException('Tenant context not found');
    }

    const conversation = await this.conversationRepo.findById(conversationId);
    if (!conversation) {
      throw new NotFoundException(`Conversation ${conversationId} not found`);
    }

    const result = await this.filesService.listConversationFiles(
      tenantId,
      conversationId,
      { mimeTypePrefix: type },
      {
        page: Math.max(1, parseInt(page, 10)),
        limit: Math.min(parseInt(limit, 10), 100),
      },
    );

    // Generate presigned URLs for each file — never expose storageKey
    const enrichedData = await Promise.all(
      result.data.map(async (file) => {
        const downloadUrl = file.path
          ? await this.filesService
              .getPresignedDownloadUrl(file.path)
              .catch(() => undefined)
          : undefined;
        const thumbnailUrl = file.thumbnailKey
          ? await this.filesService
              .getPresignedDownloadUrl(file.thumbnailKey)
              .catch(() => undefined)
          : undefined;

        return {
          id: file.id,
          fileName: file.fileName,
          mimeType: file.mimeType,
          fileSize: file.fileSize,
          category: file.category,
          source: file.source,
          messageId: file.messageId,
          uploadedBy: file.uploadedBy,
          imageMetadata: file.imageMetadata,
          tags: file.tags,
          createdAt: file.createdAt,
          downloadUrl,
          thumbnailUrl,
        };
      }),
    );

    return {
      data: enrichedData,
      total: result.total,
      page: result.page,
      limit: result.limit,
    };
  }

  /**
   * GET /omni/conversations/:id/files/images
   * Image gallery shortcut — only returns image files.
   */
  @Get('conversations/:id/files/images')
  @RequirePermission('view', 'contacts')
  async getConversationImages(
    @Param('id') conversationId: string,
    @Query('page') page = '1',
    @Query('limit') limit = '50',
  ) {
    return this.getConversationFiles(conversationId, 'image/', page, limit);
  }

  // ─── Conversion Engine (link-messages) ────────────────────────

  /**
   * POST /omni/conversations/:id/link-messages
   * Link specific messages to an existing Deal or Ticket.
   */
  @Post('conversations/:id/link-messages')
  @HttpCode(HttpStatus.OK)
  async linkMessages(
    @Param('id') conversationId: string,
    @Body() dto: LinkMessagesDto,
  ) {
    const tenantId = this.cls.get<string>('tenantId');
    if (!tenantId) {
      throw new BadRequestException('Tenant context not found');
    }

    return this.conversionService.linkMessages(tenantId, conversationId, dto);
  }

  private async resolveAgentName(agentId: string): Promise<string | null> {
    const users = await this.usersService.findByIdsGlobal([agentId]);
    const user = users[0];
    if (!user) return null;
    const fullName = [user.firstName, user.lastName]
      .filter(Boolean)
      .join(' ')
      .trim();
    return fullName || user.email || null;
  }

  /**
   * Enrich media messages that have `metadata.media.fileId` but no
   * resolved `mediaUrl` or `mediaProxyUrl`.
   *
   * This handles livechat agent-sent media: the file is uploaded to S3
   * and `fileId` is stored in metadata, but no external provider URL
   * exists. Without enrichment, the frontend shows "Media unavailable".
   *
   * Uses batch file lookup to avoid N+1 queries.
   */
  private async enrichMediaUrls(messages: any[]): Promise<any[]> {
    // Collect fileIds from messages that need URL resolution
    const msgsWithStorageKey: any[] = [];
    const needsResolution = messages.filter((msg) => {
      // For livechat visitor uploads, we have storageKey directly
      if (msg.metadata?.media?.storageKey) {
        msgsWithStorageKey.push(msg);
        return false;
      }
      return !!msg.metadata?.media?.fileId;
    });

    if (needsResolution.length === 0 && msgsWithStorageKey.length === 0)
      return messages;

    const fileIds = [
      ...new Set(
        needsResolution.map((msg) => msg.metadata.media.fileId as string),
      ),
    ];

    const fileMap = new Map<string, { path?: string }>();
    if (fileIds.length > 0) {
      try {
        const files = await this.filesService.findByIds(fileIds);
        for (const f of files) {
          if (f?.id) fileMap.set(f.id.toString(), f);
        }
      } catch {
        // Non-fatal — messages still returned without URLs
      }
    }

    return Promise.all(
      messages.map(async (msg) => {
        // 1. Resolve visitor uploads directly from storageKey
        const storageKey = msg.metadata?.media?.storageKey;
        if (storageKey) {
          try {
            const url = await this.filesService.getPresignedDownloadUrl(
              storageKey,
              3600, // 1 hour TTL
            );
            return { ...msg, mediaProxyUrl: url };
          } catch {
            return msg;
          }
        }

        // 2. Resolve agent uploads / other files via fileId lookup
        const fileId = msg.metadata?.media?.fileId;
        if (!fileId) return msg;

        const file = fileMap.get(fileId.toString?.() ?? fileId);
        if (!file?.path) return msg;

        try {
          const url = await this.filesService.getPresignedDownloadUrl(
            file.path,
            3600, // 1 hour TTL
          );
          // Overwrite with fresh signed URL
          return { ...msg, mediaProxyUrl: url };
        } catch {
          return msg;
        }
      }),
    );
  }
}
