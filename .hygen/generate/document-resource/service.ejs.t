---
to: src/<%= h.inflection.transform(name, ['pluralize', 'underscore', 'dasherize']) %>/<%= h.inflection.transform(name, ['pluralize', 'underscore', 'dasherize']) %>.service.ts
---
import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { Create<%= name %>Dto } from './dto/create-<%= h.inflection.transform(name, ['underscore', 'dasherize']) %>.dto';
import { Update<%= name %>Dto } from './dto/update-<%= h.inflection.transform(name, ['underscore', 'dasherize']) %>.dto';
import { <%= name %>Repository } from './infrastructure/persistence/<%= h.inflection.transform(name, ['underscore', 'dasherize']) %>.repository';
import { IPaginationOptions } from '../utils/types/pagination-options';
import { <%= name %> } from './domain/<%= h.inflection.transform(name, ['underscore', 'dasherize']) %>';
<% if (pagination === 'infinity') { -%>
import { InfinityPaginationResponseDto } from '../utils/dto/infinity-pagination-response.dto';
<% } else { -%>
import { PaginationResponseDto } from '../utils/dto/pagination-response.dto';
<% } -%>

/**
 * Multitenant service — tenant & user context is auto-injected by BaseDocumentRepository.
 * CLS provides: tenantId (ObjectId), userId (ObjectId) on every request.
 */
@Injectable()
export class <%= h.inflection.transform(name, ['pluralize']) %>Service {
  constructor(
    private readonly <%= h.inflection.camelize(name, true) %>Repository: <%= name %>Repository,
    private readonly cls: ClsService,
  ) {}

  /**
   * Create a new <%= name %>.
   * tenant, createdBy, updatedBy are auto-injected by BaseDocumentRepository from CLS.
   */
  async create(create<%= name %>Dto: Create<%= name %>Dto) {
    // Do not remove comment below.
    // <creating-property />

    return this.<%= h.inflection.camelize(name, true) %>Repository.create({
      ...create<%= name %>Dto,
      // Do not remove comment below.
      // <creating-property-payload />
    });
  }

  findAllWithPagination({
    paginationOptions,
  }: {
    paginationOptions: IPaginationOptions;
<% if (pagination === 'infinity') { -%>
  }): Promise<InfinityPaginationResponseDto<<%= name %>>> {
<% } else { -%>
  }): Promise<PaginationResponseDto<<%= name %>>> {
<% } -%>
    return this.<%= h.inflection.camelize(name, true) %>Repository.findAllWithPagination({
      paginationOptions: {
        page: paginationOptions.page,
        limit: paginationOptions.limit,
      },
    });
  }

  findById(id: <%= name %>['id']) {
    return this.<%= h.inflection.camelize(name, true) %>Repository.findById(id);
  }

  findByIds(ids: <%= name %>['id'][]) {
    return this.<%= h.inflection.camelize(name, true) %>Repository.findByIds(ids);
  }

  /**
   * Update a <%= name %>.
   * updatedBy is auto-injected by BaseDocumentRepository from CLS.
   */
  async update(
    id: <%= name %>['id'],
    update<%= name %>Dto: Update<%= name %>Dto,
  ) {
    // Do not remove comment below.
    // <updating-property />

    return this.<%= h.inflection.camelize(name, true) %>Repository.update(id, {
      ...update<%= name %>Dto,
      // Do not remove comment below.
      // <updating-property-payload />
    });
  }

  remove(id: <%= name %>['id']) {
    return this.<%= h.inflection.camelize(name, true) %>Repository.remove(id);
  }
}
