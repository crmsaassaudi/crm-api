import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, FilterQuery, Types } from 'mongoose';
import {
  AccountSchemaClass,
  AccountSchemaDocument,
} from '../entities/account.schema';
import { Account } from '../../../../domain/account';
import { AccountMapper } from '../mappers/account.mapper';
import { ClsService } from 'nestjs-cls';
import { BaseDocumentRepository } from '../../../../../utils/persistence/document-repository.abstract';
import { IPaginationOptions } from '../../../../../utils/types/pagination-options';
import { ICursorPaginationOptions } from '../../../../../utils/types/cursor-pagination-options';
import { PaginationResponseDto } from '../../../../../utils/dto/pagination-response.dto';
import { CursorPaginationResponseDto } from '../../../../../utils/dto/cursor-pagination-response.dto';
import { pagination } from '../../../../../utils/pagination';
import {
  buildMongoCursorFilter,
  buildMongoCursorSort,
  cursorPagination,
  decodeCursor,
  encodeCursor,
  normalizeCursorDirection,
  normalizeSortOrder,
} from '../../../../../utils/cursor-pagination';
import { escapeRegex } from '../../../../../utils/escape-regex';
import { cappedCount } from '../../../../../utils/capped-count';

@Injectable()
export class AccountRepository extends BaseDocumentRepository<
  AccountSchemaDocument,
  Account
> {
  private readonly cursorSortableFields = new Set([
    'createdAt',
    'updatedAt',
    'name',
    'industry',
    'annualRevenue',
    'numberOfEmployees',
  ]);

  constructor(
    @InjectModel(AccountSchemaClass.name)
    accountModel: Model<AccountSchemaDocument>,
    cls: ClsService,
  ) {
    super(accountModel, cls);
  }

  protected mapToDomain(doc: AccountSchemaClass): Account {
    return AccountMapper.toDomain(doc);
  }

  protected toPersistence(domain: Account): AccountSchemaClass {
    return AccountMapper.toPersistence(domain);
  }

  // ─────────────────────────── EXPORT ───────────────────────────

  private buildExportFilter(params: {
    ids?: string[];
  }): FilterQuery<AccountSchemaClass> {
    const base: FilterQuery<AccountSchemaClass> =
      params.ids && params.ids.length > 0
        ? {
            _id: {
              $in: params.ids
                .filter((id) => Types.ObjectId.isValid(id))
                .map((id) => new Types.ObjectId(id)),
            },
          }
        : {};
    return this.applyTenantFilter({
      ...base,
      deletedAt: { $exists: false },
    } as FilterQuery<AccountSchemaClass>);
  }

  /** Lean + projection + read-preference cursor for streaming exports. */
  streamForExport(
    params: { ids?: string[]; filters?: any },
    opts?: {
      projection?: Record<string, 1>;
      readPreference?: string;
      batchSize?: number;
    },
  ): AsyncIterable<any> & { close(): Promise<void> } {
    const query = this.model
      .find(this.buildExportFilter(params))
      .sort({ createdAt: -1 })
      .lean();
    if (opts?.projection) query.select(opts.projection);
    if (opts?.readPreference) query.read(opts.readPreference as any);
    return query.batchSize(opts?.batchSize ?? 1000).cursor();
  }

  async countForExport(
    params: { ids?: string[]; filters?: any },
    maxTimeMS?: number,
  ): Promise<number> {
    const query = this.model.countDocuments(this.buildExportFilter(params));
    if (maxTimeMS) query.maxTimeMS(maxTimeMS);
    return query.exec();
  }

  private buildListWhere(filterOptions?: any) {
    const where: FilterQuery<AccountSchemaClass> = {};

    if (filterOptions?.search) {
      const searchExpr = {
        $regex: escapeRegex(filterOptions.search),
        $options: 'i',
      };
      where.$or = [
        { name: searchExpr },
        { industry: searchExpr },
        { phones: searchExpr },
        { emails: searchExpr },
      ];
    }

    if (filterOptions?.filters) {
      try {
        const parsedFilters =
          typeof filterOptions.filters === 'string'
            ? JSON.parse(filterOptions.filters)
            : filterOptions.filters;
        if (Array.isArray(parsedFilters)) {
          parsedFilters.forEach((f: any) => {
            if (f.id && f.value) {
              if (['industry', 'statusId'].includes(f.id)) {
                where[f.id] = Array.isArray(f.value)
                  ? { $in: f.value }
                  : f.value;
              } else if (['owner', 'createdBy', 'updatedBy'].includes(f.id)) {
                const fieldMap: Record<string, string> = {
                  owner: 'ownerId',
                  createdBy: 'createdById',
                  updatedBy: 'updatedById',
                };
                const dbField = fieldMap[f.id] || f.id;
                where[dbField] = Array.isArray(f.value)
                  ? { $in: f.value }
                  : f.value;
              } else if (Array.isArray(f.value)) {
                where[f.id] = { $in: f.value };
              } else {
                where[f.id] = {
                  $regex: escapeRegex(String(f.value)),
                  $options: 'i',
                };
              }
            }
          });
        }
      } catch {
        // ignore parse errors
      }
    }

    return where;
  }

  async findManyWithPagination({
    filterOptions,
    paginationOptions,
  }: {
    filterOptions?: any;
    paginationOptions: IPaginationOptions;
  }): Promise<PaginationResponseDto<Account>> {
    const where = this.buildListWhere(filterOptions);

    const scopedWhere = this.applyTenantFilter(where);

    const [docs, { totalItems }] = await Promise.all([
      this.model
        .find(scopedWhere)
        .sort({ createdAt: -1 })
        .skip((paginationOptions.page - 1) * paginationOptions.limit)
        .limit(paginationOptions.limit)
        .populate('owner')
        .populate('accountStatus')
        .populate('accountType')
        .lean()
        .exec(),
      cappedCount(this.model, scopedWhere),
    ]);

    return pagination(
      docs.map((doc) => this.mapToDomain(doc as any)),
      totalItems,
      paginationOptions,
    );
  }

  async findManyWithCursorPagination({
    filterOptions,
    paginationOptions,
  }: {
    filterOptions?: any;
    paginationOptions: ICursorPaginationOptions;
  }): Promise<CursorPaginationResponseDto<Account>> {
    const where = this.buildListWhere(filterOptions);
    const scopedWhere = this.applyTenantFilter(where);
    const limit = paginationOptions.limit;
    const countLimit = paginationOptions.countLimit ?? 10_000;
    const direction = normalizeCursorDirection(paginationOptions.direction);
    const sortOrder = normalizeSortOrder(paginationOptions.sortOrder);
    const sortField = this.resolveCursorSortField(paginationOptions.sortBy);

    const cursorFilter = paginationOptions.cursor
      ? buildMongoCursorFilter<AccountSchemaClass>({
          sortField,
          sortOrder,
          direction,
          ...this.decodeDocumentCursor(
            paginationOptions.cursor,
            sortField,
            sortOrder,
          ),
        })
      : null;

    const queryWhere = cursorFilter
      ? ({
          $and: [scopedWhere, cursorFilter],
        } as FilterQuery<AccountSchemaClass>)
      : scopedWhere;

    const [docs, cappedCount] = await Promise.all([
      this.model
        .find(queryWhere)
        .sort(buildMongoCursorSort(sortField, sortOrder, direction))
        .limit(limit + 1)
        .populate('owner')
        .populate('accountStatus')
        .populate('accountType')
        .exec(),
      this.countDocumentsWithCap(scopedWhere, countLimit),
    ]);

    const hasExtraPage = docs.length > limit;
    let pageDocs = hasExtraPage ? docs.slice(0, limit) : docs;

    if (direction === 'prev') {
      pageDocs = pageDocs.reverse();
    }

    const firstDoc = pageDocs[0];
    const lastDoc = pageDocs[pageDocs.length - 1];
    const hasCursor = Boolean(paginationOptions.cursor);

    return cursorPagination(
      pageDocs.map((doc) => this.mapToDomain(doc)),
      {
        nextCursor: lastDoc
          ? this.encodeDocumentCursor(lastDoc, sortField, sortOrder)
          : null,
        prevCursor: firstDoc
          ? this.encodeDocumentCursor(firstDoc, sortField, sortOrder)
          : null,
        hasNextPage: direction === 'prev' ? hasCursor : hasExtraPage,
        hasPreviousPage: direction === 'prev' ? hasExtraPage : hasCursor,
        totalItems: cappedCount.totalItems,
        isExactCount: cappedCount.isExactCount,
      },
    );
  }

  private resolveCursorSortField(sortBy?: string): string {
    return sortBy && this.cursorSortableFields.has(sortBy)
      ? sortBy
      : 'createdAt';
  }

  private decodeDocumentCursor(
    cursor: string,
    sortField: string,
    sortOrder: 'asc' | 'desc',
  ) {
    const decoded = decodeCursor(cursor);

    if (decoded.sortBy && decoded.sortBy !== sortField) {
      throw new BadRequestException(
        'Cursor does not match the requested sort field',
      );
    }

    if (decoded.sortOrder && decoded.sortOrder !== sortOrder) {
      throw new BadRequestException(
        'Cursor does not match the requested sort order',
      );
    }

    return {
      cursorValue: this.coerceCursorValue(sortField, decoded.sortValue),
      cursorId: decoded.id,
    };
  }

  private coerceCursorValue(
    sortField: string,
    value: string | number | boolean | null,
  ): string | number | boolean | Date {
    if (value === null || value === undefined) {
      throw new BadRequestException('Invalid pagination cursor');
    }

    if (['createdAt', 'updatedAt'].includes(sortField)) {
      const date = new Date(String(value));
      if (Number.isNaN(date.getTime())) {
        throw new BadRequestException('Invalid pagination cursor');
      }

      return date;
    }

    if (['annualRevenue', 'numberOfEmployees'].includes(sortField)) {
      const numberValue = Number(value);
      if (!Number.isFinite(numberValue)) {
        throw new BadRequestException('Invalid pagination cursor');
      }

      return numberValue;
    }

    return value;
  }

  private encodeDocumentCursor(
    doc: AccountSchemaDocument,
    sortField: string,
    sortOrder: 'asc' | 'desc',
  ): string {
    const rawSortValue =
      typeof doc.get === 'function'
        ? doc.get(sortField)
        : (doc as any)[sortField];
    const sortValue =
      rawSortValue instanceof Date ? rawSortValue.toISOString() : rawSortValue;

    return encodeCursor({
      sortValue: sortValue ?? null,
      id: String((doc as any)._id),
      sortBy: sortField,
      sortOrder,
    });
  }

  private async countDocumentsWithCap(
    where: FilterQuery<AccountSchemaClass>,
    countLimit: number,
  ): Promise<{ totalItems: number; isExactCount: boolean }> {
    const docs = await this.model
      .find(where)
      .select({ _id: 1 })
      .limit(countLimit + 1)
      .lean()
      .exec();

    const isExactCount = docs.length <= countLimit;

    return {
      totalItems: isExactCount ? docs.length : countLimit,
      isExactCount,
    };
  }

  async findOne(
    filter: FilterQuery<AccountSchemaClass>,
  ): Promise<Account | null> {
    const scopedFilter = this.applyTenantFilter(filter);
    const doc = await this.model
      .findOne(scopedFilter)
      .populate('owner')
      .populate('accountStatus')
      .populate('accountType')
      .exec();
    return doc ? this.mapToDomain(doc) : null;
  }
}
