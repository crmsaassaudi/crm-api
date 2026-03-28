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
import { Public } from 'nest-keycloak-connect';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConversationRepository } from '../repositories/conversation.repository';
import { MessageRepository } from '../repositories/message.repository';
import { OutboundService } from '../services/outbound.service';
import { NoteService } from '../services/note.service';
import { ActivityService } from '../services/activity.service';

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
    private readonly outboundService: OutboundService,
    private readonly noteService: NoteService,
    private readonly activityService: ActivityService,
    private readonly cls: ClsService,
    private readonly eventEmitter: EventEmitter2,
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

    const statusFilter = status
      ? status.split(',')
      : ['open', 'pending'];

    return this.conversationRepo.findPaginated(
      {
        tenant: tenantId,
        status: statusFilter,
        channelType,
        assignedAgent,
        search,
      },
      parseInt(page, 10),
      Math.min(parseInt(limit, 10), 50), // cap at 50
    );
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

  /**
   * Get the full cross-conversation message history for a customer.
   *
   * Returns all messages from ALL past and current conversations for
   * the same customer thread (same externalId), oldest-first.
   * This gives agents full context regardless of how many sessions
   * were opened and closed.
   */
  @Get('conversations/:id/history')
  async getConversationHistory(
    @Param('id') conversationId: string,
    @Query('page') page = '1',
    @Query('limit') limit = '50',
  ) {
    const tenantId = this.cls.get<string>('tenantId');
    const conversation = await this.conversationRepo.findById(conversationId);
    if (!conversation) {
      throw new NotFoundException(`Conversation ${conversationId} not found`);
    }

    // Find ALL sessions (any status) for this customer thread
    const allConversations = await this.conversationRepo.findAllByExternalId(
      tenantId,
      conversation.channelType,
      conversation.channelAccount!,
      conversation.externalConversationId,
    );

    const conversationIds = allConversations.map((c) => c.id);

    // Return their messages combined, oldest-first, with pagination
    const messages = await this.messageRepo.findByConversationIds(
      conversationIds,
      parseInt(page, 10),
      Math.min(parseInt(limit, 10), 100),
    );

    // Include session metadata so the UI can draw separators
    return {
      ...messages,
      sessions: allConversations.map((c) => ({
        id: c.id,
        status: c.status,
        createdAt: c.createdAt,
        resolvedAt: c.resolvedAt,
        closedAt: c.closedAt,
        resolvedByAgentId: c.resolvedByAgentId,
        closedByAgentId: c.closedByAgentId,
        closeReason: c.closeReason,
        lastMessage: c.lastMessage,
      })),
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
      channelType: conversation.channelType,
      channelAccount: conversation.channelAccount,
      externalConversationId: conversation.externalConversationId,
    });

    this.logger.log(`Conversation ${id} status → ${status} (by agent ${agentId})`);
    return updated;
  }

  // ─── Tags ──────────────────────────────────────────────────────

  @Post('conversations/:id/tags')
  @HttpCode(HttpStatus.OK)
  async addTag(
    @Param('id') id: string,
    @Body('tag') tag: string,
  ) {
    if (!tag || typeof tag !== 'string') {
      throw new BadRequestException('Tag is required');
    }

    const updated = await this.conversationRepo.addTag(id, tag.trim());
    if (!updated) {
      throw new NotFoundException(`Conversation ${id} not found`);
    }

    const agentId = this.cls.get<string>('userId');
    this.eventEmitter.emit('omni.conversation.tag_added', {
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
  async assignAgent(
    @Param('id') id: string,
    @Body('agentId') agentId: string,
  ) {
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

    const updated = await this.noteService.updateNote(noteId, content, isPrivate);
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
}
