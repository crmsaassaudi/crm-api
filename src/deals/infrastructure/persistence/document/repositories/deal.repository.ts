import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, FilterQuery, Types, ClientSession } from 'mongoose';
import { DealSchemaClass, DealSchemaDocument } from '../entities/deal.schema';
import { Deal } from '../../../../domain/deal';
import { DealMapper } from '../mappers/deal.mapper';
import { ClsService } from 'nestjs-cls';
import { BaseDocumentRepository } from '../../../../../utils/persistence/document-repository.abstract';
import { VisibilityModule } from '../../../../../common/permissions/visibility-modules';
import { IPaginationOptions } from '../../../../../utils/types/pagination-options';
import { PaginationResponseDto } from '../../../../../utils/dto/pagination-response.dto';
import { pagination } from '../../../../../utils/pagination';
import { escapeRegex } from '../../../../../utils/escape-regex';
import { cappedCount } from '../../../../../utils/capped-count';
import { applyRegisteredCustomFieldFilters } from '../../../../../utils/custom-field-filter';
import { DEAL_STAGE_HISTORY_LIMIT } from '../../../../deals.constants';

/** Free-text/`$in` filterable fields. Anything else would be an unindexed scan on request. */
const REGEX_FILTERABLE_FIELDS = new Set([
  'title',
  'accountName',
  'description',
  'lostReason',
  'tags',
  'utmSource',
  'utmMedium',
  'utmCampaign',
]);

/** `filter.id` → document path, for the ids the UI uses that differ from storage. */
const FIELD_ALIASES: Record<string, string> = {
  stage: 'stageId',
  pipeline: 'pipelineId',
  owner: 'ownerId',
  source: 'sourceId',
  createdBy: 'createdById',
  updatedBy: 'updatedById',
};

/** Fields matched by exact id (single value or `$in`). */
const ID_FILTERABLE_FIELDS = new Set([
  'stageId',
  'pipelineId',
  'ownerId',
  'sourceId',
  'accountId',
  'contactIds',
  'createdById',
  'updatedById',
]);

export interface DealBoardColumn {
  stageId: string;
  dealCount: number;
  totalValue: number;
}

export interface DealCursor {
  createdAt: string;
  id: string;
}

@Injectable()
export class DealRepository extends BaseDocumentRepository<
  DealSchemaDocument,
  Deal
> {
  constructor(
    @InjectModel(DealSchemaClass.name)
    dealModel: Model<DealSchemaDocument>,
    cls: ClsService,
  ) {
    super(dealModel, cls);
  }

  /** Tagged so a tenant can scope deals differently from other modules. */
  protected visibilityModule(): VisibilityModule {
    return 'Deal';
  }

  protected mapToDomain(doc: DealSchemaClass): Deal {
    return DealMapper.toDomain(doc);
  }

  protected toPersistence(domain: Deal): DealSchemaClass {
    return DealMapper.toPersistence(domain);
  }

  protected notFoundMessage(id: string): string {
    return `Deal ${id} not found`;
  }

  /**
   * The one list predicate.
   *
   * There used to be two — `buildListWhere` (export) and `buildScopedWhere`
   * (list) — implementing the same rules twice, with the list version then
   * `Object.assign`-ing the export version over its own result and running the
   * custom-field filters twice. Two copies of a security-relevant filter is one
   * copy too many: the export path is exactly where a missed predicate leaks.
   */
  private buildWhere(filterOptions?: any): FilterQuery<DealSchemaClass> {
    // `null`, not `$exists: false` — `restore()` UNSETS the field, so `null`
    // matches both a missing field and an explicit null.
    const where: FilterQuery<DealSchemaClass> = { deletedAt: null };

    if (filterOptions?.search) {
      const expression = {
        $regex: escapeRegex(String(filterOptions.search)),
        $options: 'i',
      };
      where.$or = [{ title: expression }, { accountName: expression }];
    }

    // Named shortcuts used by the board, the omni sidebar and the follow-up views.
    if (filterOptions?.pipelineId) where.pipelineId = filterOptions.pipelineId;
    if (filterOptions?.stageId) where.stageId = filterOptions.stageId;
    if (filterOptions?.contactId) where.contactIds = filterOptions.contactId;
    if (filterOptions?.ownerId) where.ownerId = filterOptions.ownerId;

    this.applyOpenClosedFilter(where, filterOptions?.state);
    this.applyFollowUpFilter(where, filterOptions?.followUp);
    this.applyGenericFilters(where, filterOptions?.filters);

    applyRegisteredCustomFieldFilters(
      where,
      filterOptions?.filters,
      filterOptions?.__customFieldDefinitions,
    );

    // Object-ACL denies resolved by the service — a collection route has no `:id`
    // for `@UseAcl` to narrow to, so without this a denied deal was blocked on
    // open and visible in the list.
    const excludeIds: string[] = filterOptions?.__excludeIds ?? [];
    if (excludeIds.length > 0) {
      where._id = {
        ...(where._id as Record<string, unknown> | undefined),
        $nin: excludeIds
          .filter((id) => Types.ObjectId.isValid(id))
          .map((id) => new Types.ObjectId(id)),
      };
    }

    return this.applyTenantFilter(where);
  }

  private applyOpenClosedFilter(
    where: FilterQuery<DealSchemaClass>,
    state?: string,
  ): void {
    if (state === 'open') {
      where.wonAt = null;
      where.lostAt = null;
    } else if (state === 'won') {
      where.wonAt = { $ne: null };
    } else if (state === 'lost') {
      where.lostAt = { $ne: null };
    }
  }

  /**
   * The follow-up queue — the view a B2C rep lives in.
   *
   * `overdue` is "committed to a touch that has come and gone"; `today` is what
   * is still owed before midnight. Both exclude closed deals: a won deal owes
   * nobody a call.
   */
  private applyFollowUpFilter(
    where: FilterQuery<DealSchemaClass>,
    followUp?: string,
  ): void {
    if (!followUp) return;

    const now = new Date();
    const endOfDay = new Date(now);
    endOfDay.setHours(23, 59, 59, 999);

    if (followUp === 'overdue') {
      where.nextFollowUpAt = { $ne: null, $lt: now };
    } else if (followUp === 'today') {
      where.nextFollowUpAt = { $ne: null, $lte: endOfDay };
    } else if (followUp === 'none') {
      where.nextFollowUpAt = null;
    } else {
      return;
    }
    where.wonAt = null;
    where.lostAt = null;
  }

  private applyGenericFilters(
    where: FilterQuery<DealSchemaClass>,
    rawFilters: unknown,
  ): void {
    const filters = this.parseFilters(rawFilters);

    for (const filter of filters) {
      if (!filter?.id || filter.value === undefined || filter.value === null) {
        continue;
      }
      // Registered custom fields are handled by applyRegisteredCustomFieldFilters.
      if (String(filter.id).startsWith('customFields.')) continue;

      const field = FIELD_ALIASES[filter.id] ?? filter.id;
      const value = filter.value;

      if (ID_FILTERABLE_FIELDS.has(field)) {
        where[field] = Array.isArray(value) ? { $in: value } : value;
        continue;
      }

      if (field === 'value') {
        const numeric = Number(value);
        if (!Number.isNaN(numeric)) where.value = numeric;
        continue;
      }

      if (!REGEX_FILTERABLE_FIELDS.has(field)) continue;

      where[field] = Array.isArray(value)
        ? { $in: value }
        : { $regex: escapeRegex(String(value)), $options: 'i' };
    }
  }

  private parseFilters(raw: unknown): Array<{ id?: string; value?: unknown }> {
    if (Array.isArray(raw)) return raw;
    if (typeof raw !== 'string') return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return []; // a malformed filter narrows nothing rather than failing the request
    }
  }

  private populateList<T>(query: T): T {
    return (query as any)
      .populate('owner')
      .populate('dealStage')
      .populate('dealSource');
  }

  // Reads

  async findManyWithPagination({
    filterOptions,
    paginationOptions,
  }: {
    filterOptions?: any;
    paginationOptions: IPaginationOptions;
  }): Promise<PaginationResponseDto<Deal>> {
    const where = this.buildWhere(filterOptions);

    const [docs, { totalItems }] = await Promise.all([
      this.populateList(
        this.model
          .find(where)
          .sort({ createdAt: -1, _id: -1 })
          .skip((paginationOptions.page - 1) * paginationOptions.limit)
          .limit(paginationOptions.limit),
      )
        .lean()
        .exec(),
      cappedCount(this.model as Model<any>, where),
    ]);

    return pagination(
      docs.map((doc) => this.mapToDomain(doc as any)),
      totalItems,
      paginationOptions,
    );
  }

  /**
   * Keyset pagination — how the board loads a column and how deep list pages stay
   * cheap. `.skip()` walks and discards every skipped document; keyset seeks
   * straight to the position through `tenant_pipeline_stage_cursor`.
   */
  async findManyByCursor({
    filterOptions,
    cursor,
    limit,
  }: {
    filterOptions?: any;
    cursor?: DealCursor | null;
    limit: number;
  }): Promise<{ data: Deal[]; nextCursor: DealCursor | null }> {
    const where = this.buildWhere(filterOptions);

    const scopedWhere: FilterQuery<DealSchemaClass> = cursor
      ? {
          $and: [
            where,
            {
              $or: [
                { createdAt: { $lt: new Date(cursor.createdAt) } },
                {
                  createdAt: new Date(cursor.createdAt),
                  _id: { $lt: new Types.ObjectId(cursor.id) },
                },
              ],
            },
          ],
        }
      : where;

    const docs = await this.populateList(
      this.model
        .find(scopedWhere)
        .sort({ createdAt: -1, _id: -1 })
        .limit(limit + 1),
    )
      .lean()
      .exec();

    const hasMore = docs.length > limit;
    const page = hasMore ? docs.slice(0, limit) : docs;
    const last = page[page.length - 1] as any;

    return {
      data: page.map((doc) => this.mapToDomain(doc as any)),
      nextCursor:
        hasMore && last
          ? {
              createdAt: new Date(last.createdAt).toISOString(),
              id: String(last._id),
            }
          : null,
    };
  }

  /**
   * Per-stage count and value for one pipeline, computed by the database.
   *
   * The board used to derive both in the browser from whatever page of deals had
   * been fetched, so a column header read "12 · $40,000" when the stage actually
   * held twelve thousand deals. Those numbers are what a manager steers by, so
   * they have to come from the same predicate the column itself uses.
   */
  async boardSummary(filterOptions?: any): Promise<DealBoardColumn[]> {
    const where = this.buildWhere(filterOptions);

    const rows = await this.model
      .aggregate<{
        _id: Types.ObjectId;
        dealCount: number;
        totalValue: number;
      }>([
        { $match: where },
        {
          $group: {
            _id: '$stageId',
            dealCount: { $sum: 1 },
            totalValue: { $sum: '$value' },
          },
        },
      ])
      .exec();

    return rows.map((row) => ({
      stageId: String(row._id),
      dealCount: row.dealCount,
      totalValue: row.totalValue ?? 0,
    }));
  }

  async findOne(filter: FilterQuery<DealSchemaClass>): Promise<Deal | null> {
    // Once deletion became a soft delete, an unfiltered lookup began SERVING
    // deleted records — `GET /:id` answering 200, and automation's `fetchRecord`
    // resuming delayed workflows against something the user had deleted.
    // Passing `deletedAt` explicitly opts out, for restore and purge paths.
    const scopedFilter = this.applyTenantFilter(
      filter.deletedAt !== undefined ? filter : { ...filter, deletedAt: null },
    );
    const doc = await this.populateList(this.model.findOne(scopedFilter))
      .populate('pipeline')
      .exec();
    return doc ? this.mapToDomain(doc) : null;
  }

  /** Same-tenant duplicate probe. Ignores data-visibility on purpose — see DealsService.checkDuplicate. */
  async existsOpenDuplicate(params: {
    title: string;
    accountId?: string;
  }): Promise<boolean> {
    const filter: FilterQuery<DealSchemaClass> = {
      title: params.title,
      deletedAt: null,
      wonAt: null,
      lostAt: null,
    };
    if (params.accountId) filter.accountId = params.accountId;
    const found = await this.model
      .findOne(filter)
      .select({ _id: 1 })
      .lean()
      .exec();
    return Boolean(found);
  }

  // Writes

  /**
   * Append one transition to the deal's history.
   *
   * `$push` with `$slice` rather than a read-modify-write of the whole array:
   * two reps moving the same card at once would otherwise each write back an
   * array missing the other's entry, and the cap keeps a long-lived deal from
   * growing an unbounded document.
   */
  async appendStageHistory(
    id: string,
    entry: {
      fromStageId: string | null;
      toStageId: string;
      changedAt: Date;
      changedById: string | null;
      durationMs: number | null;
    },
    session?: ClientSession,
  ): Promise<void> {
    await this.model
      .updateOne(
        this.applyTenantFilter({ _id: id } as FilterQuery<DealSchemaClass>),
        {
          $push: {
            stageHistory: {
              $each: [entry],
              $slice: -DEAL_STAGE_HISTORY_LIMIT,
            },
          },
        } as any,
        session ? { session } : {},
      )
      .exec();
  }

  async addTagsToDeals(
    dealIds: string[],
    tags: string[],
  ): Promise<{ matchedCount: number; modifiedCount: number }> {
    const scopedFilter = this.applyTenantFilter({
      _id: { $in: dealIds },
      deletedAt: null,
    } as FilterQuery<DealSchemaClass>);
    const result = await this.model
      .updateMany(scopedFilter, { $addToSet: { tags: { $each: tags } } })
      .exec();

    return {
      matchedCount: result.matchedCount,
      modifiedCount: result.modifiedCount,
    };
  }

  // Export

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

  private buildExportFilter(params: {
    ids?: string[];
    filters?: any;
  }): FilterQuery<DealSchemaClass> {
    if (!params.ids?.length) return this.buildWhere(params.filters);

    return this.applyTenantFilter({
      _id: {
        $in: params.ids
          .filter((id) => Types.ObjectId.isValid(id))
          .map((id) => new Types.ObjectId(id)),
      },
      deletedAt: null,
    } as FilterQuery<DealSchemaClass>);
  }

  // Retention

  /**
   * Records soft-deleted before `cutoff`, for the retention purge.
   *
   * `isPlatformQuery` because the caller is a cron: retention applies to every
   * tenant, and without the flag `tenantFilterPlugin` throws on a missing CLS
   * tenant. Oldest deletion first, so a backlog drains in the order it built up.
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

  /** Hard-delete one deal. Only DealPurgeService may call this. */
  async hardDelete(id: string, session?: ClientSession): Promise<void> {
    await this.model
      .deleteOne({ _id: id })
      .setOptions({ isPlatformQuery: true } as any)
      .session(session ?? null)
      .exec();
  }
}
