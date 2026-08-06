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
import { VisibilityModule } from '../../../../../common/permissions/visibility-modules';
import { IPaginationOptions } from '../../../../../utils/types/pagination-options';
import { ICursorPaginationOptions } from '../../../../../utils/types/cursor-pagination-options';
import { PaginationResponseDto } from '../../../../../utils/dto/pagination-response.dto';
import { CursorPaginationResponseDto } from '../../../../../utils/dto/cursor-pagination-response.dto';
import { pagination } from '../../../../../utils/pagination';
import { applyRegisteredCustomFieldFilters } from '../../../../../utils/custom-field-filter';
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
import { SORTABLE_FIELDS } from '../../../../../object-manager/sortable-fields';

@Injectable()
export class AccountRepository extends BaseDocumentRepository<
  AccountSchemaDocument,
  Account
> {
  private readonly cursorSortableFields = new Set<string>(
    SORTABLE_FIELDS.Account,
  );

  constructor(
    @InjectModel(AccountSchemaClass.name)
    accountModel: Model<AccountSchemaDocument>,
    cls: ClsService,
  ) {
    super(accountModel, cls);
  }

  /** Tagged so a tenant can scope accounts differently from other modules. */
  protected visibilityModule(): VisibilityModule {
    return 'Account';
  }

  protected mapToDomain(doc: AccountSchemaClass): Account {
    return AccountMapper.toDomain(doc);
  }

  protected toPersistence(domain: Account): AccountSchemaClass {
    return AccountMapper.toPersistence(domain);
  }

  private buildExportFilter(params: {
    ids?: string[];
    filters?: any;
  }): FilterQuery<AccountSchemaClass> {
    if (params.ids && params.ids.length > 0) {
      return this.applyTenantFilter({
        _id: {
          $in: params.ids
            .filter((id) => Types.ObjectId.isValid(id))
            .map((id) => new Types.ObjectId(id)),
        },
        deletedAt: null,
      } as FilterQuery<AccountSchemaClass>);
    }
    return this.applyTenantFilter(this.buildListWhere(params.filters));
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

  /**
   * Accounts that share any identity key with the supplied one.
   *
   * A single `$or` rather than three queries: the caller then ranks the results by
   * confidence, so the strongest available signal wins without three round trips.
   * Capped, because a weak name key can legitimately match many rows and a duplicate
   * warning does not need all of them.
   */
  async findIdentityCandidates(
    keys: { nameKey?: string; websiteDomain?: string; taxIdKey?: string },
    excludeId?: string,
  ): Promise<Account[]> {
    const clauses: FilterQuery<AccountSchemaClass>[] = [];
    if (keys.taxIdKey) clauses.push({ taxIdKey: keys.taxIdKey });
    if (keys.websiteDomain) clauses.push({ websiteDomain: keys.websiteDomain });
    if (keys.nameKey) clauses.push({ nameKey: keys.nameKey });
    if (clauses.length === 0) return [];

    const where: FilterQuery<AccountSchemaClass> = {
      $or: clauses,
      deletedAt: null,
    };
    if (excludeId) where._id = { $ne: excludeId };

    const docs = await this.model
      .find(this.applyTenantFilter(where))
      .select({
        name: 1,
        website: 1,
        taxId: 1,
        nameKey: 1,
        websiteDomain: 1,
        taxIdKey: 1,
      })
      .limit(25)
      .lean()
      .exec();

    return docs.map((doc) => this.mapToDomain(doc as any));
  }

  private buildListWhere(filterOptions?: any) {
    const where: FilterQuery<AccountSchemaClass> = {
      // Exclude soft-deleted accounts.
      //
      // This builder was the only list query in the CRM that never filtered
      // `deletedAt` — deals, tickets, tasks and contacts all did. It did not show
      // while `remove()` issued `deleteOne`, because the row was gone; once deletion
      // became a soft delete the accounts list started listing deleted accounts.
      // `null` rather than `$exists: false` so a restored row (which unsets the field)
      // and a legacy row (which never had it) both count as live.
      deletedAt: null,

      // Exclude archived accounts unless explicitly asked for.
      //
      // `isArchived` was declared on the schema, the domain model and the mapper, was
      // writable through the API — and was read by nothing. So a client could archive
      // an account, get a 200, and watch it stay in every list: an affordance that
      // lied. Archiving is a real concept distinct from deletion (keep the history,
      // hide it from working views) and this repo already implements it that way for
      // deal pipelines, so the fix is to honour the field rather than delete it.
      //
      // `$ne: true` not `false`, because the overwhelming majority of existing
      // documents have no such field at all.
      ...(filterOptions?.includeArchived ? {} : { isArchived: { $ne: true } }),
    };

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
              if (String(f.id).startsWith('customFields.')) return;
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

    applyRegisteredCustomFieldFilters(
      where,
      filterOptions?.filters,
      filterOptions?.__customFieldDefinitions,
    );

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
      cappedCount(this.model as any, scopedWhere),
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
    // Exclude soft-deleted records unless the caller asks for one explicitly.
    //
    // Harmless while `remove()` hard-deleted: the row was gone, so the lookup
    // returned null by itself. Once deletion became a soft delete the unfiltered
    // lookup began SERVING deleted records — `GET /:id` answering 200 instead of
    // 404, the detail page rendering a deleted record as editable, and automation's
    // `fetchRecord` resuming delayed workflows against it, which is how a
    // "wait 3 days then email" step ends up acting on something the user deleted.
    //
    // Passing `deletedAt` explicitly opts out, for merge and restore paths that
    // legitimately need to load an archived row.
    const scopedFilter = this.applyTenantFilter(
      filter.deletedAt !== undefined ? filter : { ...filter, deletedAt: null },
    );
    const doc = await this.model
      .findOne(scopedFilter)
      .populate('owner')
      .populate('accountStatus')
      .populate('accountType')
      .exec();
    return doc ? this.mapToDomain(doc) : null;
  }

  /**
   * Accounts soft-deleted before `cutoff`, for the retention purge.
   *
   * Runs WITHOUT the tenant filter by design: the purge cron has no request context, and
   * retention applies to every tenant. `applyTenantFilter` would return nothing there,
   * which is the quiet failure — a purge that logs success and deletes nothing.
   *
   * Oldest deletion first, so a backlog drains in the order it accumulated.
   */
  async findPurgeable(
    cutoff: Date,
    limit: number,
  ): Promise<Array<{ id: string; tenantId: string }>> {
    const docs = await this.model
      .find({ deletedAt: { $ne: null, $lte: cutoff } })
      .setOptions({ isPlatformQuery: true } as any)
      .select({ _id: 1, tenantId: 1 })
      .sort({ deletedAt: 1 })
      .limit(limit)
      .lean()
      .exec();
    return docs.map((doc: any) => ({
      id: String(doc._id),
      tenantId: String(doc.tenantId),
    }));
  }

  /** Hard-delete one account. Only AccountPurgeService may call this. */
  async hardDelete(id: string): Promise<void> {
    await this.model
      .deleteOne({ _id: id })
      .setOptions({ isPlatformQuery: true } as any)
      .exec();
  }

  /**
   * Apply `data` only if the document is still at `version`.
   *
   * Exists for merge. The merge lock serialises merges of the same pair, but not an
   * ordinary PATCH by someone who had the account open — without this check that edit
   * is silently overwritten by the pre-merge snapshot the merge is working from.
   * Returns null on a version mismatch so the caller can report a conflict rather than
   * report success over lost work.
   */
  async updateWithVersionCheck(
    id: string,
    version: number,
    data: Partial<AccountSchemaClass>,
  ): Promise<Account | null> {
    const scopedFilter = this.applyTenantFilter({
      _id: id,
      __v: version,
    } as FilterQuery<AccountSchemaClass>);
    const updatedById = this.cls.get('userId') ?? this.cls.get('user.id');
    const doc = await this.model
      .findOneAndUpdate(
        scopedFilter,
        {
          $set: { ...data, ...(updatedById ? { updatedById } : {}) },
          $inc: { __v: 1 },
        },
        { new: true },
      )
      .exec();
    return doc ? this.mapToDomain(doc) : null;
  }

  async addTagsToAccounts(
    accountIds: string[],
    tags: string[],
  ): Promise<{ matchedCount: number; modifiedCount: number }> {
    const scopedFilter = this.applyTenantFilter({
      _id: { $in: accountIds },
      deletedAt: { $exists: false },
    } as FilterQuery<AccountSchemaClass>);
    const result = await this.model
      .updateMany(scopedFilter, {
        $addToSet: { tags: { $each: tags } },
      })
      .exec();

    return {
      matchedCount: result.matchedCount,
      modifiedCount: result.modifiedCount,
    };
  }
}
