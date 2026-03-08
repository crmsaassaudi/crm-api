import { Injectable } from '@nestjs/common';
import { AccountRepository } from './infrastructure/persistence/document/repositories/account.repository';
import { Account } from './domain/account';

@Injectable()
export class AccountsService {
  constructor(private readonly repository: AccountRepository) {}

  async create(data: Partial<Account>): Promise<Account> {
    const owner = data.owner === '' ? undefined : data.owner;
    return this.repository.create({
      ...data,
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

  async findOne(id: string): Promise<Account | null> {
    return this.repository.findOne({ _id: id });
  }

  async update(id: string, data: Partial<Account>): Promise<Account | null> {
    const owner = data.owner === '' ? undefined : data.owner;
    return this.repository.update(id, {
      ...data,
      owner,
    } as any);
  }

  async remove(id: string): Promise<void> {
    return this.repository.remove(id);
  }
}
