import { Injectable } from '@nestjs/common';
import { TaskRepository } from './infrastructure/persistence/document/repositories/task.repository';
import { Task } from './domain/task';

@Injectable()
export class TasksService {
  constructor(private readonly repository: TaskRepository) {}

  async create(data: Partial<Task>): Promise<Task> {
    const ownerId = data.ownerId === '' ? undefined : data.ownerId;

    return this.repository.create({
      ...data,
      ownerId,
      status: data.status || 'not_started',
      category: data.category || 'todo',
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

  async findOne(id: string): Promise<Task | null> {
    return this.repository.findOne({ _id: id });
  }

  async update(id: string, data: Partial<Task>): Promise<Task | null> {
    const ownerId = data.ownerId === '' ? undefined : data.ownerId;

    const updateData: any = { ...data, ownerId };

    // Auto-set completedAt when status changes to completed
    if (data.status === 'completed' && !data.completedAt) {
      updateData.completedAt = new Date();
    }

    return this.repository.update(id, updateData);
  }

  async remove(id: string): Promise<void> {
    return this.repository.remove(id);
  }
}
