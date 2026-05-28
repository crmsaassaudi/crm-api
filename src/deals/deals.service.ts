import { Injectable } from '@nestjs/common';
import { DealRepository } from './infrastructure/persistence/document/repositories/deal.repository';
import { Deal } from './domain/deal';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { EntityAuditService } from '../common/audit/entity-audit.service';

@Injectable()
export class DealsService {
  constructor(
    private readonly repository: DealRepository,
    private readonly cls: ClsService,
    private readonly eventEmitter: EventEmitter2,
    private readonly entityAudit: EntityAuditService,
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
      this.entityAudit.emit({
        entity: 'deal',
        entityType: 'DEAL',
        entityId: id,
        kind: 'updated',
        oldSnapshot: existingDeal ?? {},
        newSnapshot: updated,
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

