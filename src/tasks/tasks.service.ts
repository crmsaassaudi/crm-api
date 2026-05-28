import { Injectable } from '@nestjs/common';
import { TaskRepository } from './infrastructure/persistence/document/repositories/task.repository';
import { Task } from './domain/task';
import { EntityAuditService } from '../common/audit/entity-audit.service';

@Injectable()
export class TasksService {
  constructor(
    private readonly repository: TaskRepository,
    private readonly entityAudit: EntityAuditService,
  ) {}

  async create(data: Partial<Task>): Promise<Task> {
    const ownerId = data.ownerId === '' ? undefined : data.ownerId;

    const task = await this.repository.create({
      ...data,
      ownerId,
      statusId: data.statusId,
      categoryId: data.categoryId,
    } as any);

    this.entityAudit.emit({
      entity: 'task',
      entityType: 'TASK',
      entityId: task.id,
      kind: 'created',
      newSnapshot: task,
    });

    return task;
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

  async findOne(id: string): Promise<Task | null> {
    return this.repository.findOne({ _id: id });
  }

  async update(id: string, data: Partial<Task>): Promise<Task | null> {
    const existing = await this.repository.findOne({ _id: id });
    const ownerId = data.ownerId === '' ? undefined : data.ownerId;

    const updateData: any = { ...data, ownerId };

    // Auto-set completedAt when task is marked with a terminal status
    // The frontend should send completedAt when appropriate
    if (
      data.completedAt === undefined &&
      updateData.completedAt === undefined
    ) {
      // no-op: let the frontend decide
    }

    const updated = await this.repository.update(id, updateData);

    if (updated) {
      this.entityAudit.emit({
        entity: 'task',
        entityType: 'TASK',
        entityId: id,
        kind: 'updated',
        oldSnapshot: existing ?? {},
        newSnapshot: updated,
      });
    }

    return updated;
  }

  async remove(id: string): Promise<void> {
    const existing = await this.repository.findOne({ _id: id });
    await this.repository.remove(id);
    this.entityAudit.emit({
      entity: 'task',
      entityType: 'TASK',
      entityId: id,
      kind: 'updated',
      oldSnapshot: existing ?? {},
      newSnapshot: { _deleted: true } as any,
    });
  }
}
