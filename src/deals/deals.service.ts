import { Injectable } from '@nestjs/common';
import { DealRepository } from './infrastructure/persistence/document/repositories/deal.repository';
import { Deal } from './domain/deal';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';

@Injectable()
export class DealsService {
  constructor(
    private readonly repository: DealRepository,
    private readonly cls: ClsService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async create(data: Partial<Deal>): Promise<Deal> {
    const ownerId = data.ownerId === '' ? undefined : data.ownerId;
    return this.repository.create({
      ...data,
      name: data.title || data.name,
      ownerId,
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

  async findOne(id: string): Promise<Deal | null> {
    return this.repository.findOne({ _id: id });
  }

  async update(id: string, data: Partial<Deal>): Promise<Deal | null> {
    // Snapshot before update for audit trail
    const existingDeal = await this.repository.findOne({ _id: id });

    const ownerId = data.ownerId === '' ? undefined : data.ownerId;
    const updated = await this.repository.update(id, {
      ...data,
      name: data.title || data.name,
      ownerId,
    } as any);

    // Emit audit trail event: field-level change tracking
    if (updated) {
      this.eventEmitter.emit('deal.updated', {
        t: new Date(),
        tenantId:
          this.cls.get('activeTenantId') || this.cls.get('tenantId'),
        entityId: id,
        entityType: 'DEAL',
        oldSnapshot: existingDeal
          ? JSON.parse(JSON.stringify(existingDeal))
          : {},
        newSnapshot: JSON.parse(JSON.stringify(updated)),
        actorId: this.getCurrentUserId(),
        src: this.cls.get('executionSource') || 'M',
        ctx: this.cls.get('sourceContext'),
        ip: this.cls.get('requestIp'),
        ua: this.cls.get('userAgent'),
      });
    }

    return updated;
  }

  async remove(id: string): Promise<void> {
    return this.repository.remove(id);
  }

  private getCurrentUserId(): string | undefined {
    return this.cls.get('userId') || this.cls.get('user.id');
  }
}

