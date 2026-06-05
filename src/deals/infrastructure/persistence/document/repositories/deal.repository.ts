import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, FilterQuery, Types } from 'mongoose';
import { DealSchemaClass, DealSchemaDocument } from '../entities/deal.schema';
import { Deal } from '../../../../domain/deal';
import { DealMapper } from '../mappers/deal.mapper';
import { ClsService } from 'nestjs-cls';
import { BaseDocumentRepository } from '../../../../../utils/persistence/document-repository.abstract';
import { IPaginationOptions } from '../../../../../utils/types/pagination-options';
import { PaginationResponseDto } from '../../../../../utils/dto/pagination-response.dto';
import { pagination } from '../../../../../utils/pagination';
import { escapeRegex } from '../../../../../utils/escape-regex';
import { cappedCount } from '../../../../../utils/capped-count';

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

  protected mapToDomain(doc: DealSchemaClass): Deal {
    return DealMapper.toDomain(doc);
  }

  protected toPersistence(domain: Deal): DealSchemaClass {
    return DealMapper.toPersistence(domain);
  }

  // ─────────────────────────── EXPORT ───────────────────────────

  private buildExportFilter(params: {
    ids?: string[];
  }): FilterQuery<DealSchemaClass> {
    const base: FilterQuery<DealSchemaClass> =
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
    const where: FilterQuery<DealSchemaClass> = {};

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

    if (filterOptions?.filters) {
      try {
        const parsedFilters =
          typeof filterOptions.filters === 'string'
            ? JSON.parse(filterOptions.filters)
            : filterOptions.filters;
        if (Array.isArray(parsedFilters)) {
          parsedFilters.forEach((f: any) => {
            if (f.id && f.value) {
              if (['stageId'].includes(f.id)) {
                where[f.id] = f.value;
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
      cappedCount(this.model, scopedWhere),
    ]);

    return pagination(
      docs.map((doc) => this.mapToDomain(doc as any)),
      totalItems,
      paginationOptions,
    );
  }

  async findOne(filter: FilterQuery<DealSchemaClass>): Promise<Deal | null> {
    const scopedFilter = this.applyTenantFilter(filter);
    const doc = await this.model
      .findOne(scopedFilter)
      .populate('owner')
      .populate('dealStage')
      .populate('dealSource')
      .exec();
    return doc ? this.mapToDomain(doc) : null;
  }
}
