import { Injectable } from '@nestjs/common';
import { DealRepository } from './infrastructure/persistence/document/repositories/deal.repository';
import { Deal } from './domain/deal';

@Injectable()
export class DealsService {
  constructor(private readonly repository: DealRepository) {}

  async create(data: Partial<Deal>): Promise<Deal> {
    // Sanitize owner: empty string is not a valid ObjectId
    const owner = data.owner === '' ? undefined : data.owner;

    // tenant, createdBy, updatedBy are auto-injected by BaseDocumentRepository from CLS
    return this.repository.create({
      ...data,
      owner,
    } as any);
  }

  async findAll(): Promise<Deal[]> {
    return this.repository.find({});
  }

  async findOne(id: string): Promise<Deal | null> {
    return this.repository.findOne({ _id: id });
  }

  async update(id: string, data: Partial<Deal>): Promise<Deal | null> {
    // Sanitize owner: empty string is not a valid ObjectId
    const owner = data.owner === '' ? undefined : data.owner;

    // updatedBy is auto-injected by BaseDocumentRepository from CLS
    return this.repository.update(id, {
      ...data,
      owner,
    } as any);
  }

  async remove(id: string): Promise<void> {
    return this.repository.remove(id);
  }
}
