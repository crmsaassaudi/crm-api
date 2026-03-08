import { Injectable } from '@nestjs/common';
import { DealRepository } from './infrastructure/persistence/document/repositories/deal.repository';
import { Deal } from './domain/deal';

@Injectable()
export class DealsService {
  constructor(private readonly repository: DealRepository) {}

  async create(data: Partial<Deal>): Promise<Deal> {
    const owner = data.owner === '' ? undefined : data.owner;
    return this.repository.create({
      ...data,
      name: data.title || data.name,
      owner,
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
    const owner = data.owner === '' ? undefined : data.owner;
    return this.repository.update(id, {
      ...data,
      name: data.title || data.name,
      owner,
    } as any);
  }

  async remove(id: string): Promise<void> {
    return this.repository.remove(id);
  }
}
