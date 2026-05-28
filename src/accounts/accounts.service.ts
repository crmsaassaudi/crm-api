import { Injectable } from '@nestjs/common';
import { AccountRepository } from './infrastructure/persistence/document/repositories/account.repository';
import { Account } from './domain/account';
import {
  DEFAULT_CURSOR_COUNT_LIMIT,
  clampPaginationLimit,
  resolvePaginationMode,
} from '../utils/cursor-pagination';
import { EntityAuditService } from '../common/audit/entity-audit.service';

@Injectable()
export class AccountsService {
  constructor(
    private readonly repository: AccountRepository,
    private readonly entityAudit: EntityAuditService,
  ) {}

  async create(data: Partial<Account>): Promise<Account> {
    const ownerId = data.ownerId === '' ? undefined : data.ownerId;
    const phones = data.phones ?? [];
    const emails = data.emails ?? [];
    const account = await this.repository.create({
      ...data,
      phones,
      emails,
      ownerId,
    } as any);

    this.entityAudit.emit({
      entity: 'account',
      entityType: 'ACCOUNT',
      entityId: account.id,
      kind: 'created',
      newSnapshot: account,
    });

    return account;
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
    // Snapshot before write so AuditLogListener can compute a field-level
    // diff. Previously this service did not emit any audit signal — the
    // 2026-05-28 review flagged it as a coverage gap.
    const existing = await this.repository.findOne({ _id: id });
    const ownerId = data.ownerId === '' ? undefined : data.ownerId;
    const phones = data.phones;
    const emails = data.emails;
    const updated = await this.repository.update(id, {
      ...data,
      ...(phones !== undefined ? { phones } : {}),
      ...(emails !== undefined ? { emails } : {}),
      ownerId,
    } as any);

    if (updated) {
      this.entityAudit.emit({
        entity: 'account',
        entityType: 'ACCOUNT',
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
      entity: 'account',
      entityType: 'ACCOUNT',
      entityId: id,
      kind: 'updated',
      oldSnapshot: existing ?? {},
      newSnapshot: { _deleted: true } as any,
    });
  }
}
