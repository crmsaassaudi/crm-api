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
import { ConversationRepository } from '../repositories/conversation.repository';
import { MessageRepository } from '../repositories/message.repository';
import { OutboundService } from '../../omni-outbound/outbound.service';
import { NoteService } from '../services/note.service';
import { ActivityService } from '../services/activity.service';
import { ConversationService } from '../services/conversation.service';
import { ConversionService } from '../services/conversion.service';
import { TimelineQueryDto } from '../dto/timeline-query.dto';
import { CreateDealFromConversationDto } from '../dto/create-deal-from-conversation.dto';
import { CreateTicketFromConversationDto } from '../dto/create-ticket-from-conversation.dto';
import { LinkMessagesDto } from '../dto/link-messages.dto';
import { UsersService } from '../../users/users.service';
import { TenantsService } from '../../tenants/tenants.service';

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
    private readonly conversionService: ConversionService,
    private readonly outboundService: OutboundService,
    private readonly noteService: NoteService,
    private readonly activityService: ActivityService,
    private readonly cls: ClsService,
    private readonly eventEmitter: EventEmitter2,
    private readonly usersService: UsersService,
    private readonly tenantsService: TenantsService,
  ) {}

  // ─── Conversations ────────────────────────────────────────────

  /**
   * List conversations for the current tenant, paginated.
   * Supports filtering by status, channelType, assignedAgent, and search.
   */
  @Get('conversations')
  async listConversations(
    @Query('page') page = '1',
    @Query('limit') limit = '20',
    @Query('status') status?: string,
    @Query('channelType') channelType?: string,
    @Query('assignedAgent') assignedAgent?: string,
    @Query('search') search?: string,
  ) {
    const tenantId = this.cls.get<string>('tenantId');
    if (!tenantId) {
      throw new BadRequestException('Tenant context not found');
    }

    const statusFilter = status ? status.split(',') : ['open', 'pending'];

    console.log(
      `[DEBUG] listConversations: tenantId=${tenantId}, statusFilter=${JSON.stringify(statusFilter)}`,
    );

    const result = await this.conversationRepo.findPaginated(
      {
        tenantId,
        status: statusFilter,
        channelType,
        assignedAgent,
        search,
      },
      parseInt(page, 10),
      Math.min(parseInt(limit, 10), 50), // cap at 50
    );

    // Resolve display-friendly resolver info for list cards (name/email),
    // so UI does not have to show raw IDs.
    const resolverIds = Array.from(
      new Set(
        result.data
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
        ? (resolverMap.get(c.resolvedByAgentId) ?? null)
        : null;

      const resolvedDisplay = resolvedFromPopulate ?? resolvedFromMap;

      return {
        ...c,
        resolvedByAgentName: resolvedDisplay?.name ?? null,
        resolvedByAgentEmail: resolvedDisplay?.email ?? null,
      };
    });

    console.log(`[DEBUG] listConversations: found ${result.data.length} items`);
    return {
      ...result,
      data: enrichedData,
    };
  }

  /**
   * Get a single conversation by ID (with customer info).
   */
  @Get('conversations/:id')
  async getConversation(@Param('id') id: string) {
    const conversation = await this.conversationRepo.findById(id);
    if (!conversation) {
      throw new NotFoundException(`Conversation ${id} not found`);
    }
    return conversation;
  }

  // ─── Messages ─────────────────────────────────────────────────

  /**
   * Get paginated messages for a conversation.
   * Returns oldest-first for chat display.
   */
  @Get('conversations/:id/messages')
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

    return this.messageRepo.findByConversation(
      conversationId,
      parseInt(page, 10),
      Math.min(parseInt(limit, 10), 100),
    );
  }

  @Get('conversations/:id/timeline')
  async getConversationTimeline(
    @Param('id') conversationId: string,
    @Query() query: TimelineQueryDto,
  ) {
    const tenantId = this.cls.get<string>('tenantId');
    if (!tenantId) {
      throw new BadRequestException('Tenant context not found');
    }

    return this.conversationService.getConversationTimeline({
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
  @HttpCode(HttpStatus.CREATED)
  async sendMessage(
    @Param('id') conversationId: string,
    @Body('content') content: string,
    @Body('messageType') messageType?: string,
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
      });
    } catch (error) {
      this.logger.error(`Failed to send message: ${error.message}`);
      throw new BadRequestException(error.message);
    }
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

    let updated;
    if (status === 'resolved' || status === 'closed') {
      updated = await this.conversationRepo.updateStatusWithMetadata(
        id,
        status,
        agentId,
        reason,
        note,
        resolveSource ?? 'agent',
      );
    } else {
      updated = await this.conversationRepo.updateStatus(id, status);
    }

    // Emit event for cache invalidation, audit trail, and WebSocket broadcast
    this.eventEmitter.emit('omni.conversation.status_changed', {
      tenantId: conversation.tenantId,
      conversationId: id,
      status,
      oldStatus,
      agentId,
      reason,
      note,
      resolveSource: resolveSource ?? 'agent',
      channelType: conversation.channelType,
      channelAccount: conversation.channelAccount,
      externalConversationId: conversation.externalConversationId,
    });

    this.logger.log(
      `Conversation ${id} status → ${status} (by ${resolveSource ?? 'agent'} ${agentId})`,
    );
    return updated;
  }

  // ─── Tags ──────────────────────────────────────────────────────

  @Post('conversations/:id/tags')
  @HttpCode(HttpStatus.OK)
  async addTag(@Param('id') id: string, @Body('tag') tag: string) {
    if (!tag || typeof tag !== 'string') {
      throw new BadRequestException('Tag is required');
    }

    const updated = await this.conversationRepo.addTag(id, tag.trim());
    if (!updated) {
      throw new NotFoundException(`Conversation ${id} not found`);
    }

    const agentId = this.cls.get<string>('userId');
    const tenantId = this.cls.get<string>('tenantId');
    this.eventEmitter.emit('omni.conversation.tag_added', {
      tenantId,
      conversationId: id,
      tag: tag.trim(),
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
   * Assign or reassign agent to a conversation.
   */
  @Patch('conversations/:id/assign')
  @HttpCode(HttpStatus.OK)
  async assignAgent(@Param('id') id: string, @Body('agentId') agentId: string) {
    if (!agentId) {
      throw new BadRequestException('agentId is required');
    }

    const conversation = await this.conversationRepo.findById(id);
    if (!conversation) {
      throw new NotFoundException(`Conversation ${id} not found`);
    }

    const oldAgentId = conversation.assignedAgentId;
    const updated = await this.conversationRepo.updateAssignment(id, agentId);

    this.eventEmitter.emit('omni.conversation.assigned', {
      tenantId: conversation.tenantId,
      conversationId: id,
      agentId,
      oldAgentId,
    });

    this.logger.log(`Conversation ${id} assigned to agent ${agentId}`);
    return updated;
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
    const updated = await this.conversationRepo.updateAssignment(id, null);

    this.eventEmitter.emit('omni.conversation.assigned', {
      tenantId: conversation.tenantId,
      conversationId: id,
      agentId: null,
      oldAgentId,
    });

    this.logger.log(`Conversation ${id} unassigned`);
    return updated;
  }

  // ─── Notes ──────────────────────────────────────────────────────

  @Post('conversations/:id/notes')
  @HttpCode(HttpStatus.CREATED)
  async createNote(
    @Param('id') conversationId: string,
    @Body('content') content: string,
    @Body('isPrivate') isPrivate?: boolean,
    @Body('mentions') mentions?: string[],
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

  @Patch('conversations/:convId/notes/:noteId')
  @HttpCode(HttpStatus.OK)
  async updateNote(
    @Param('noteId') noteId: string,
    @Body('content') content: string,
    @Body('isPrivate') isPrivate?: boolean,
  ) {
    if (!content) {
      throw new BadRequestException('Content is required');
    }

    const updated = await this.noteService.updateNote(
      noteId,
      content,
      isPrivate,
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
    await this.conversationRepo.resetUnreadCount(id);
  }

  // ─── Settings ─────────────────────────────────────────────────

  /**
   * GET /omni/settings
   * Returns current omni-channel settings for the tenant.
   */
  @Get('settings')
  async getSettings() {
    const tenantId = this.cls.get<string>('tenantId');
    if (!tenantId) throw new BadRequestException('Tenant context not found');
    const tenant = await this.tenantsService.findById(tenantId);
    return tenant?.omniSettings ?? { resolveNoteMode: 'optional' };
  }

  /**
   * PATCH /omni/settings
   * Updates omni-channel settings.
   */
  @Patch('settings')
  async updateSettings(@Body('resolveNoteMode') resolveNoteMode: string) {
    const tenantId = this.cls.get<string>('tenantId');
    if (!tenantId) throw new BadRequestException('Tenant context not found');

    const validModes = ['disabled', 'optional', 'required'];
    if (!validModes.includes(resolveNoteMode)) {
      throw new BadRequestException(
        `resolveNoteMode must be one of: ${validModes.join(', ')}`,
      );
    }

    await this.tenantsService.updateOmniSettings(tenantId, {
      resolveNoteMode: resolveNoteMode as 'disabled' | 'optional' | 'required',
    });
    return { resolveNoteMode };
  }

  /**
   * GET /omni/settings/storage-quota
   * Returns the current tenant's storage usage and limit.
   */
  @Get('settings/storage-quota')
  async getStorageQuota() {
    const tenantId = this.cls.get<string>('tenantId');
    if (!tenantId) throw new BadRequestException('Tenant context not found');
    return this.tenantsService.checkStorageQuota(tenantId);
  }

  /**
   * PATCH /omni/settings/storage-quota
   * Update the tenant's storage limit (admin).
   */
  @Patch('settings/storage-quota')
  async updateStorageQuota(@Body('limitMB') limitMB: number) {
    const tenantId = this.cls.get<string>('tenantId');
    if (!tenantId) throw new BadRequestException('Tenant context not found');

    if (typeof limitMB !== 'number' || (limitMB < 0 && limitMB !== -1)) {
      throw new BadRequestException(
        'limitMB must be a positive number or -1 (unlimited)',
      );
    }

    await this.tenantsService.updateStorageQuota(tenantId, limitMB);
    return { limitMB };
  }

  // ─── Conversion Engine (Deal / Ticket from Conversation) ──────

  /**
   * POST /omni/conversations/:id/create-deal
   * Create a Deal linked to this omni-conversation.
   */
  @Post('conversations/:id/create-deal')
  @HttpCode(HttpStatus.CREATED)
  async createDealFromConversation(
    @Param('id') conversationId: string,
    @Body() dto: CreateDealFromConversationDto,
  ) {
    const tenantId = this.cls.get<string>('tenantId');
    const agentId = this.cls.get<string>('userId');
    if (!tenantId || !agentId) {
      throw new BadRequestException('User or Tenant context not found');
    }

    return this.conversionService.createDeal(
      tenantId,
      agentId,
      conversationId,
      dto,
    );
  }

  /**
   * POST /omni/conversations/:id/create-ticket
   * Create a Ticket linked to this omni-conversation.
   */
  @Post('conversations/:id/create-ticket')
  @HttpCode(HttpStatus.CREATED)
  async createTicketFromConversation(
    @Param('id') conversationId: string,
    @Body() dto: CreateTicketFromConversationDto,
  ) {
    const tenantId = this.cls.get<string>('tenantId');
    const agentId = this.cls.get<string>('userId');
    if (!tenantId || !agentId) {
      throw new BadRequestException('User or Tenant context not found');
    }

    return this.conversionService.createTicket(
      tenantId,
      agentId,
      conversationId,
      dto,
    );
  }

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
}
