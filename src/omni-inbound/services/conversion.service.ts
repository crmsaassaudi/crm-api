import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { ConversationRepository } from '../repositories/conversation.repository';
import { DealsService } from '../../deals/deals.service';
import { TicketsService } from '../../tickets/tickets.service';
import { DealRepository } from '../../deals/infrastructure/persistence/document/repositories/deal.repository';
import { TicketRepository } from '../../tickets/infrastructure/persistence/document/repositories/ticket.repository';
import { CreateDealFromConversationDto } from '../dto/create-deal-from-conversation.dto';
import { CreateTicketFromConversationDto } from '../dto/create-ticket-from-conversation.dto';
import { LinkMessagesDto } from '../dto/link-messages.dto';
import { Deal } from '../../deals/domain/deal';
import { Ticket } from '../../tickets/domain/ticket';

/**
 * ConversionService — creates Deal/Lead or Ticket entities directly
 * from an omni-channel conversation, and links specific chat messages
 * to those entities for cross-module timeline visibility.
 */
@Injectable()
export class ConversionService {
  private readonly logger = new Logger(ConversionService.name);

  constructor(
    private readonly conversationRepo: ConversationRepository,
    private readonly dealsService: DealsService,
    private readonly ticketsService: TicketsService,
    private readonly dealRepo: DealRepository,
    private readonly ticketRepo: TicketRepository,
  ) {}

  /**
   * Create a Deal linked to an omni-conversation.
   * The conversation's contactId(s) are automatically attached to the deal.
   */
  async createDeal(
    tenantId: string,
    agentId: string,
    conversationId: string,
    dto: CreateDealFromConversationDto,
  ): Promise<Deal> {
    const conversation = await this.conversationRepo.findById(conversationId);
    if (!conversation || conversation.tenantId !== tenantId) {
      throw new NotFoundException(`Conversation ${conversationId} not found`);
    }

    const contactIds = conversation.contactId ? [conversation.contactId] : [];

    const deal = await this.dealsService.create({
      tenantId,
      title: dto.title,
      name: dto.title,
      pipeline: dto.pipeline ?? 'default',
      stage: dto.stage ?? 'new',
      value: dto.value ?? 0,
      currency: 'VND',
      source: 'omni-channel',
      contactIds,
      omniConversationId: conversationId,
      linkedMessageIds: dto.linkedMessageIds ?? [],
      createdById: agentId,
      updatedById: agentId,
    } as Partial<Deal>);

    this.logger.log(
      `Created Deal ${deal.id} from conversation ${conversationId} by agent ${agentId}`,
    );

    return deal;
  }

  /**
   * Create a Ticket linked to an omni-conversation.
   */
  async createTicket(
    tenantId: string,
    agentId: string,
    conversationId: string,
    dto: CreateTicketFromConversationDto,
  ): Promise<Ticket> {
    const conversation = await this.conversationRepo.findById(conversationId);
    if (!conversation || conversation.tenantId !== tenantId) {
      throw new NotFoundException(`Conversation ${conversationId} not found`);
    }

    const ticket = await this.ticketsService.create({
      tenantId,
      subject: dto.subject,
      description: dto.description ?? '',
      priority: dto.priority ?? 'MEDIUM',
      status: 'new',
      channel: 'omni-channel',
      source: 'omni-channel',
      requesterId: conversation.contactId ?? undefined,
      omniConversationId: conversationId,
      linkedMessageIds: dto.linkedMessageIds ?? [],
      createdById: agentId,
      updatedById: agentId,
    } as Partial<Ticket>);

    this.logger.log(
      `Created Ticket ${ticket.id} from conversation ${conversationId} by agent ${agentId}`,
    );

    return ticket;
  }

  /**
   * Link specific omni-channel messages to an existing Deal or Ticket.
   * Uses $addToSet to avoid duplicates.
   */
  async linkMessages(
    tenantId: string,
    conversationId: string,
    dto: LinkMessagesDto,
  ): Promise<{ linked: number }> {
    // Validate conversation belongs to tenant
    const conversation = await this.conversationRepo.findById(conversationId);
    if (!conversation || conversation.tenantId !== tenantId) {
      throw new NotFoundException(`Conversation ${conversationId} not found`);
    }

    if (!dto.messageIds || dto.messageIds.length === 0) {
      throw new BadRequestException('messageIds cannot be empty');
    }

    if (dto.targetType === 'deal') {
      const deal = await this.dealRepo.findOne({ _id: dto.targetId });
      if (!deal) {
        throw new NotFoundException(`Deal ${dto.targetId} not found`);
      }
      const existing = deal.linkedMessageIds ?? [];
      const merged = Array.from(new Set([...existing, ...dto.messageIds]));
      await this.dealRepo.update(dto.targetId, {
        linkedMessageIds: merged,
      } as Partial<Deal>);
    } else {
      const ticket = await this.ticketRepo.findOne({ _id: dto.targetId });
      if (!ticket) {
        throw new NotFoundException(`Ticket ${dto.targetId} not found`);
      }
      const existing = ticket.linkedMessageIds ?? [];
      const merged = Array.from(new Set([...existing, ...dto.messageIds]));
      await this.ticketRepo.update(dto.targetId, {
        linkedMessageIds: merged,
      } as Partial<Ticket>);
    }

    this.logger.log(
      `Linked ${dto.messageIds.length} messages to ${dto.targetType} ${dto.targetId}`,
    );

    return { linked: dto.messageIds.length };
  }
}
