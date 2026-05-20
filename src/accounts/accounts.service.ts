import { Injectable } from '@nestjs/common';
import { AccountRepository } from './infrastructure/persistence/document/repositories/account.repository';
import { Account } from './domain/account';
import {
  DEFAULT_CURSOR_COUNT_LIMIT,
  clampPaginationLimit,
  resolvePaginationMode,
} from '../utils/cursor-pagination';

@Injectable()
export class AccountsService {
  constructor(private readonly repository: AccountRepository) {}

  async create(data: Partial<Account>): Promise<Account> {
    const ownerId = data.ownerId === '' ? undefined : data.ownerId;
    const phones = data.phones ?? [];
    const emails = data.emails ?? [];
    return this.repository.create({
      ...data,
      phones,
      emails,
      ownerId,
    } as any);
  }

  async findAll(filter: any): Promise<any> {
    const limit = clampPaginationLimit(filter.limit);

    if (resolvePaginationMode(filter) === 'cursor') {
      return this.repository.findManyWithCursorPagination({
        filterOptions: filter,
        paginationOptions: {
          limit,
          cursor: filter.cursor,
          direction: filter.direction,
          sortBy: filter.sortBy,
          sortOrder: filter.sortOrder,
          countLimit: DEFAULT_CURSOR_COUNT_LIMIT,
        },
      });
    }

    return this.repository.findManyWithPagination({
      filterOptions: filter,
      paginationOptions: {
        page: Number(filter.page) || 1,
        limit,
      },
    });
  }

  async findOne(id: string): Promise<Account | null> {
    return this.repository.findOne({ _id: id });
  }

  async update(id: string, data: Partial<Account>): Promise<Account | null> {
    const ownerId = data.ownerId === '' ? undefined : data.ownerId;
    const phones = data.phones;
    const emails = data.emails;
    return this.repository.update(id, {
      ...data,
      ...(phones !== undefined ? { phones } : {}),
      ...(emails !== undefined ? { emails } : {}),
      ownerId,
    } as any);
  }

  async remove(id: string): Promise<void> {
    return this.repository.remove(id);
  }
}
