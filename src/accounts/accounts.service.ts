import { Injectable } from '@nestjs/common';
import { AccountRepository } from './infrastructure/persistence/document/repositories/account.repository';
import { Account } from './domain/account';

@Injectable()
export class AccountsService {
  constructor(private readonly repository: AccountRepository) {}

  async create(data: Partial<Account>): Promise<Account> {
    // Sanitize owner: empty string is not a valid ObjectId
    const owner = data.owner === '' ? undefined : data.owner;

    // tenant, createdBy, updatedBy are auto-injected by BaseDocumentRepository from CLS
    return this.repository.create({
      ...data,
      owner,
    } as any);
  }

  async findAll(): Promise<Account[]> {
    return this.repository.find({});
  }

  async findOne(id: string): Promise<Account | null> {
    return this.repository.findOne({ _id: id });
  }

  async update(id: string, data: Partial<Account>): Promise<Account | null> {
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
