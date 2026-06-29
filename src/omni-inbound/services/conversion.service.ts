import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { ConversationRepository } from '../repositories/conversation.repository';
import { DealRepository } from '../../deals/infrastructure/persistence/document/repositories/deal.repository';
import { TicketRepository } from '../../tickets/infrastructure/persistence/document/repositories/ticket.repository';
import { LinkMessagesDto } from '../dto/link-messages.dto';
import { Deal } from '../../deals/domain/deal';
import { Ticket } from '../../tickets/domain/ticket';

/**
 * ConversionService — links specific chat messages to Deal or Ticket entities
 * for cross-module timeline visibility.
 *
 * Deal and Ticket creation now go through their standard APIs (/deals, /tickets)
 * directly from the frontend, with omni context (contactId, omniConversationId,
 * channel) injected client-side from the store state.
 */
@Injectable()
export class ConversionService {
  private readonly logger = new Logger(ConversionService.name);

  constructor(
    private readonly conversationRepo: ConversationRepository,
    private readonly dealRepo: DealRepository,
    private readonly ticketRepo: TicketRepository,
  ) {}

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
