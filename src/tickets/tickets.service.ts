import { Injectable } from '@nestjs/common';
import { TicketRepository } from './infrastructure/persistence/document/repositories/ticket.repository';
import { Ticket } from './domain/ticket';
import { TicketSettingsService } from '../ticket-settings/ticket-settings.service';

@Injectable()
export class TicketsService {
  constructor(
    private readonly repository: TicketRepository,
    private readonly ticketSettingsService: TicketSettingsService,
  ) {}

  async create(data: Partial<Ticket>): Promise<Ticket> {
    const ownerId = data.ownerId === '' ? undefined : data.ownerId;
    const groupId = data.groupId === '' ? undefined : data.groupId;
    const ticketNumber = await this.repository.generateTicketNumber();

    return this.repository.create({
      ...data,
      ticketNumber,
      ownerId,
      groupId,
      isSlaBreached: false,
      timeSpentSeconds: 0,
    } as any);
  }

  async findAll(filter: any): Promise<any> {
    return this.repository.findManyWithPagination({
      filterOptions: filter,
      paginationOptions: {
        page: Number(filter.page) || 1,
        limit: Number(filter.limit) || 10,
      },
    });
  }

  async findOne(id: string): Promise<Ticket | null> {
    return this.repository.findOne({ _id: id });
  }

  async update(id: string, data: Partial<Ticket>): Promise<Ticket | null> {
    const ownerId = data.ownerId === '' ? undefined : data.ownerId;
    const groupId = data.groupId === '' ? undefined : data.groupId;

    const updateData: any = { ...data, ownerId, groupId };

    // Auto-set timestamps based on terminal status
    if (data.statusId) {
      const status = await this.ticketSettingsService.findStatusById(
        data.statusId,
      );
      if (status?.isTerminal) {
        if (!data.resolvedAt) {
          updateData.resolvedAt = new Date();
        }
        if (!data.closedAt) {
          updateData.closedAt = new Date();
        }
      }
    }

    return this.repository.update(id, updateData);
  }

  async remove(id: string): Promise<void> {
    return this.repository.remove(id);
  }
}
