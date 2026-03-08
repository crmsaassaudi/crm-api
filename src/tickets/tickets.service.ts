import { Injectable } from '@nestjs/common';
import { TicketRepository } from './infrastructure/persistence/document/repositories/ticket.repository';
import { Ticket } from './domain/ticket';

@Injectable()
export class TicketsService {
  constructor(private readonly repository: TicketRepository) {}

  async create(data: Partial<Ticket>): Promise<Ticket> {
    const assignee = data.assignee === '' ? undefined : data.assignee;
    const ticketNumber = await this.repository.generateTicketNumber();

    return this.repository.create({
      ...data,
      ticketNumber,
      assignee,
      status: data.status || 'new',
      lifecycleStage: data.lifecycleStage || 'new',
      slaBreached: false,
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
    const assignee = data.assignee === '' ? undefined : data.assignee;

    const updateData: any = { ...data, assignee };

    // Auto-set timestamps based on status changes
    if (data.status === 'resolved' && !data.resolvedAt) {
      updateData.resolvedAt = new Date();
    }
    if (data.status === 'closed' && !data.closedAt) {
      updateData.closedAt = new Date();
    }

    return this.repository.update(id, updateData);
  }

  async remove(id: string): Promise<void> {
    return this.repository.remove(id);
  }
}
