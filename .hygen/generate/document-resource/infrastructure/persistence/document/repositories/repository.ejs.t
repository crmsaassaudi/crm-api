---
to: src/<%= h.inflection.transform(name, ['pluralize', 'underscore', 'dasherize']) %>/infrastructure/persistence/document/repositories/<%= h.inflection.transform(name, ['underscore', 'dasherize']) %>.repository.ts
---
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, FilterQuery } from 'mongoose';
import { ClsService } from 'nestjs-cls';
import { <%= name %>SchemaClass, <%= name %>SchemaDocument } from '../entities/<%= h.inflection.transform(name, ['underscore', 'dasherize']) %>.schema';
import { <%= name %> } from '../../../../domain/<%= h.inflection.transform(name, ['underscore', 'dasherize']) %>';
import { <%= name %>Mapper } from '../mappers/<%= h.inflection.transform(name, ['underscore', 'dasherize']) %>.mapper';
import { BaseDocumentRepository } from '../../../../../utils/persistence/document-repository.abstract';
import { IPaginationOptions } from '../../../../../utils/types/pagination-options';
<% if (pagination === 'infinity') { -%>
import { InfinityPaginationResponseDto } from '../../../../../utils/dto/infinity-pagination-response.dto';
import { infinityPagination } from '../../../../../utils/infinity-pagination';
<% } else { -%>
import { PaginationResponseDto } from '../../../../../utils/dto/pagination-response.dto';
import { pagination } from '../../../../../utils/pagination';
<% } -%>

/**
 * Multitenant repository — extends BaseDocumentRepository which provides:
 *   - Automatic tenant filtering on all queries (via CLS tenantId)
 *   - Auto-injection of tenant, createdBy, updatedBy on create/update
 */
@Injectable()
export class <%= name %>DocumentRepository extends BaseDocumentRepository<<%= name %>SchemaDocument, <%= name %>> {
  constructor(
    @InjectModel(<%= name %>SchemaClass.name)
    <%= h.inflection.camelize(name, true) %>Model: Model<<%= name %>SchemaDocument>,
    cls: ClsService,
  ) {
    super(<%= h.inflection.camelize(name, true) %>Model, cls);
  }

  protected mapToDomain(doc: <%= name %>SchemaClass): <%= name %> {
    return <%= name %>Mapper.toDomain(doc);
  }

  protected toPersistence(domain: <%= name %>): <%= name %>SchemaClass {
    return <%= name %>Mapper.toPersistence(domain);
  }

  async findAllWithPagination({
    paginationOptions,
  }: {
    paginationOptions: IPaginationOptions;
<% if (pagination === 'infinity') { -%>
  }): Promise<InfinityPaginationResponseDto<<%= name %>>> {
    const scopedFilter = this.applyTenantFilter({});
    const entityObjects = await this.model
      .find(scopedFilter)
      .sort({ createdAt: -1 })
      .skip((paginationOptions.page - 1) * paginationOptions.limit)
      .limit(paginationOptions.limit)
      .populate('createdBy')
      .populate('updatedBy')
      .exec();

    const domainEntities = entityObjects.map((doc) => this.mapToDomain(doc));
    return infinityPagination(domainEntities, paginationOptions);
  }
<% } else { -%>
  }): Promise<PaginationResponseDto<<%= name %>>> {
    const scopedFilter = this.applyTenantFilter({});
    const [entityObjects, totalItems] = await Promise.all([
      this.model
        .find(scopedFilter)
        .sort({ createdAt: -1 })
        .skip((paginationOptions.page - 1) * paginationOptions.limit)
        .limit(paginationOptions.limit)
        .populate('createdBy')
        .populate('updatedBy')
        .exec(),
      this.model.countDocuments(scopedFilter).exec(),
    ]);

    const domainEntities = entityObjects.map((doc) => this.mapToDomain(doc));
    return pagination(domainEntities, totalItems, paginationOptions);
  }
<% } -%>

  async findOne(filter: FilterQuery<<%= name %>SchemaClass>): Promise<<%= name %> | null> {
    const scopedFilter = this.applyTenantFilter(filter);
    const doc = await this.model
      .findOne(scopedFilter)
      .populate('createdBy')
      .populate('updatedBy')
      .exec();
    return doc ? this.mapToDomain(doc) : null;
  }
}
