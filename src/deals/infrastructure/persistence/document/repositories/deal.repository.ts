import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, FilterQuery, Types } from 'mongoose';
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

  private buildListWhere(filterOptions?: any): FilterQuery<DealSchemaClass> {
    const where: FilterQuery<DealSchemaClass> = { deletedAt: null };
    if (filterOptions?.search) {
      const expression = {
        $regex: escapeRegex(filterOptions.search),
        $options: 'i',
      };
      where.$or = [
        { title: expression },
        { name: expression },
        { accountName: expression },
      ];
    }
    if (filterOptions?.stage) where.stageId = filterOptions.stage;
    if (filterOptions?.contactId) where.contactIds = filterOptions.contactId;
    if (filterOptions?.filters) {
      try {
        const filters =
          typeof filterOptions.filters === 'string'
            ? JSON.parse(filterOptions.filters)
            : filterOptions.filters;
        if (Array.isArray(filters)) {
          filters.forEach((filter: any) => {
            if (!filter.id || !filter.value) return;
            if (String(filter.id).startsWith('customFields.')) return;
            if (filter.id === 'stage' || filter.id === 'stageId') {
              where.stageId = filter.value;
            } else if (filter.id === 'pipelineId') {
              where.pipelineId = filter.value;
            } else if (filter.id === 'value') {
              const value = Number(filter.value);
              if (!Number.isNaN(value)) where[filter.id] = value;
            } else if (
              ['owner', 'createdBy', 'updatedBy'].includes(filter.id)
            ) {
              const field =
                (
                  {
                    owner: 'ownerId',
                    createdBy: 'createdById',
                    updatedBy: 'updatedById',
                  } as Record<string, string>
                )[filter.id] ?? filter.id;
              where[field] = Array.isArray(filter.value)
                ? { $in: filter.value }
                : filter.value;
            } else if (Array.isArray(filter.value)) {
              where[filter.id] = { $in: filter.value };
            } else {
              where[filter.id] = {
                $regex: escapeRegex(String(filter.value)),
                $options: 'i',
              };
            }
          });
        }
      } catch {
        // Keep malformed-filter behavior aligned with list requests.
      }
    }
    applyRegisteredCustomFieldFilters(
      where,
      filterOptions?.filters,
      filterOptions?.__customFieldDefinitions,
    );
    return where;
  }

  private buildExportFilter(params: {
    ids?: string[];
    filters?: any;
  }): FilterQuery<DealSchemaClass> {
    if (!params.ids?.length) {
      return this.applyTenantFilter(this.buildListWhere(params.filters));
    }
    return this.applyTenantFilter({
      _id: {
        $in: params.ids
          .filter((id) => Types.ObjectId.isValid(id))
          .map((id) => new Types.ObjectId(id)),
      },
      deletedAt: null,
    } as FilterQuery<DealSchemaClass>);
  }

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

  async findManyWithPagination({
    filterOptions,
    paginationOptions,
  }: {
    filterOptions?: any;
    paginationOptions: IPaginationOptions;
  }): Promise<PaginationResponseDto<Deal>> {
    // Exclude soft-deleted records.
    //
    // Missed twice before this. §20 made deletion a soft delete across six collections,
    // and the inventory written afterwards only inspected `findOne` — so a LIST query
    // that never filtered `deletedAt` stayed invisible to it. Accounts was found in §28
    // and recorded there as "the only list query in the CRM" doing this; it was not.
    //
    // `null` rather than `$exists: false`, because `restore()` UNSETS the field: `null`
    // matches both a missing field and an explicit null, so a restored row and a legacy
    // row both read as live.
    const where: FilterQuery<DealSchemaClass> = { deletedAt: null };

    if (filterOptions?.search) {
      const searchExpr = {
        $regex: escapeRegex(filterOptions.search),
        $options: 'i',
      };
      where.$or = [
        { title: searchExpr },
        { name: searchExpr },
        { accountName: searchExpr },
      ];
    }

    if (filterOptions?.stage) {
      where.stageId = filterOptions.stage;
    }

    // Precise contact lookup — used by Omni-Channel CustomerContext sidebar
    if (filterOptions?.contactId) {
      where.contactIds = filterOptions.contactId; // MongoDB array-contains match
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
              if (['stage', 'stageId'].includes(f.id)) {
                where.stageId = f.value;
              } else if (f.id === 'pipelineId') {
                where.pipelineId = f.value;
              } else if (f.id === 'value') {
                const val = Number(f.value);
                if (!isNaN(val)) where[f.id] = val;
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

    Object.assign(where, this.buildListWhere(filterOptions));
    const scopedWhere = this.applyTenantFilter(where);

    const [docs, { totalItems }] = await Promise.all([
      this.model
        .find(scopedWhere)
        .sort({ createdAt: -1 })
        .skip((paginationOptions.page - 1) * paginationOptions.limit)
        .limit(paginationOptions.limit)
        .populate('owner')
        .populate('dealStage')
        .populate('dealSource')
        .lean()
        .exec(),
      cappedCount(this.model as Model<any>, scopedWhere),
    ]);

    return pagination(
      docs.map((doc) => this.mapToDomain(doc as any)),
      totalItems,
      paginationOptions,
    );
  }

  async findOne(filter: FilterQuery<DealSchemaClass>): Promise<Deal | null> {
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
      .populate('dealStage')
      .populate('dealSource')
      .exec();
    return doc ? this.mapToDomain(doc) : null;
  }

  async addTagsToDeals(
    dealIds: string[],
    tags: string[],
  ): Promise<{ matchedCount: number; modifiedCount: number }> {
    const scopedFilter = this.applyTenantFilter({
      _id: { $in: dealIds },
      deletedAt: { $exists: false },
    } as FilterQuery<DealSchemaClass>);
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

  /**
   * Records soft-deleted before `cutoff`, for the retention purge.
   *
   * `isPlatformQuery` because the caller is a cron: retention applies to every tenant, and
   * without the flag `tenantFilterPlugin` throws on a missing CLS tenant — which is how
   * four nightly jobs came to fail on their first query while logging "skipped".
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

  /** Hard-delete one deal. Only DealPurgeService may call this. */
  async hardDelete(id: string): Promise<void> {
    await this.model
      .deleteOne({ _id: id })
      .setOptions({ isPlatformQuery: true } as any)
      .exec();
  }
}
