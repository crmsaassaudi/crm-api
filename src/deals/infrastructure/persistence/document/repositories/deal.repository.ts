import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, FilterQuery } from 'mongoose';
import { DealSchemaClass, DealSchemaDocument } from '../entities/deal.schema';
import { Deal } from '../../../../domain/deal';
import { DealMapper } from '../mappers/deal.mapper';
import { ClsService } from 'nestjs-cls';
import { BaseDocumentRepository } from '../../../../../utils/persistence/document-repository.abstract';
import { IPaginationOptions } from '../../../../../utils/types/pagination-options';
import { PaginationResponseDto } from '../../../../../utils/dto/pagination-response.dto';
import { pagination } from '../../../../../utils/pagination';

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

  async findManyWithPagination({
    filterOptions,
    paginationOptions,
  }: {
    filterOptions?: any;
    paginationOptions: IPaginationOptions;
  }): Promise<PaginationResponseDto<Deal>> {
    const where: FilterQuery<DealSchemaClass> = {};

    if (filterOptions?.search) {
      const searchExpr = { $regex: filterOptions.search, $options: 'i' };
      where.$or = [
        { title: searchExpr },
        { name: searchExpr },
        { accountName: searchExpr },
      ];
    }

    if (filterOptions?.stage) {
      where.stage = filterOptions.stage;
    }

    if (filterOptions?.filters) {
      try {
        const parsedFilters = typeof filterOptions.filters === 'string' 
          ? JSON.parse(filterOptions.filters) 
          : filterOptions.filters;
        if (Array.isArray(parsedFilters)) {
          parsedFilters.forEach((f: any) => {
            if (f.id && f.value) {
              if (['stage'].includes(f.id)) {
                where[f.id] = f.value;
              } else if (f.id === 'value') {
                const val = Number(f.value);
                if (!isNaN(val)) where[f.id] = val;
              } else {
                where[f.id] = { $regex: f.value, $options: 'i' };
              }
            }
          });
        }
      } catch (e) {
        // ignore parse errors
      }
    }

    const scopedWhere = this.applyTenantFilter(where);

    const [docs, totalItems] = await Promise.all([
      this.model
        .find(scopedWhere)
        .sort({ createdAt: -1 })
        .skip((paginationOptions.page - 1) * paginationOptions.limit)
        .limit(paginationOptions.limit)
        .populate('owner')
        .exec(),
      this.model.countDocuments(scopedWhere).exec(),
    ]);

    return pagination(
      docs.map((doc) => this.mapToDomain(doc)),
      totalItems,
      paginationOptions,
    );
  }

  async findOne(filter: FilterQuery<DealSchemaClass>): Promise<Deal | null> {
    const scopedFilter = this.applyTenantFilter(filter);
    const doc = await this.model.findOne(scopedFilter).populate('owner').exec();
    return doc ? this.mapToDomain(doc) : null;
  }
}
