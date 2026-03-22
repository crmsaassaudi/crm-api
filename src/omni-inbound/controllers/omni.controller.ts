import {
  Controller,
  Get,
  Patch,
  Post,
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
import { ConversationRepository } from '../repositories/conversation.repository';
import { MessageRepository } from '../repositories/message.repository';
import { OutboundService } from '../services/outbound.service';

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
 */
@Controller({ path: 'omni', version: '1' })
export class OmniController {
  private readonly logger = new Logger(OmniController.name);

  constructor(
    private readonly conversationRepo: ConversationRepository,
    private readonly messageRepo: MessageRepository,
    private readonly outboundService: OutboundService,
    private readonly cls: ClsService,
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
   * Allows an agent to end a session. If a customer messages again later,
   * a new conversation will be created automatically by ConversationService.
   */
  @Patch('conversations/:id/status')
  @HttpCode(HttpStatus.OK)
  async updateStatus(
    @Param('id') id: string,
    @Body('status') status: string,
  ) {
    const validStatuses = ['open', 'pending', 'resolved', 'closed'];
    if (!validStatuses.includes(status)) {
      throw new BadRequestException(
        `Invalid status. Must be one of: ${validStatuses.join(', ')}`,
      );
    }

    const updated = await this.conversationRepo.updateStatus(id, status);
    if (!updated) {
      throw new NotFoundException(`Conversation ${id} not found`);
    }

    this.logger.log(`Conversation ${id} status → ${status}`);
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

  // ─── Read / Unread ─────────────────────────────────────────────

  @Patch('conversations/:id/read')
  @HttpCode(HttpStatus.NO_CONTENT)
  async markAsRead(@Param('id') id: string) {
    await this.conversationRepo.resetUnreadCount(id);
  }
}
