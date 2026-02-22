---
to: src/<%= h.inflection.transform(name, ['pluralize', 'underscore', 'dasherize']) %>/infrastructure/persistence/<%= h.inflection.transform(name, ['underscore', 'dasherize']) %>.repository.ts
---
import { ClientSession } from 'mongoose';
import { DeepPartial } from '../../../utils/types/deep-partial.type';
import { NullableType } from '../../../utils/types/nullable.type';
import { IPaginationOptions } from '../../../utils/types/pagination-options';
import { <%= name %> } from '../../domain/<%= h.inflection.transform(name, ['underscore', 'dasherize']) %>';
<% if (pagination === 'infinity') { -%>
import { InfinityPaginationResponseDto } from '../../../utils/dto/infinity-pagination-response.dto';
<% } else { -%>
import { PaginationResponseDto } from '../../../utils/dto/pagination-response.dto';
<% } -%>

export abstract class <%= name %>Repository {
  abstract create(
    data: Omit<<%= name %>, 'id' | 'createdAt' | 'updatedAt'>,
    options?: { session?: ClientSession },
  ): Promise<<%= name %>>;

  abstract findAllWithPagination({
    paginationOptions,
  }: {
    paginationOptions: IPaginationOptions;
<% if (pagination === 'infinity') { -%>
  }, options?: { session?: ClientSession }): Promise<InfinityPaginationResponseDto<<%= name %>>>;
<% } else { -%>
  }, options?: { session?: ClientSession }): Promise<PaginationResponseDto<<%= name %>>>;
<% } -%>

  abstract findById(
    id: <%= name %>['id'],
    options?: { session?: ClientSession },
  ): Promise<NullableType<<%= name %>>>;

  abstract findByIds(
    ids: <%= name %>['id'][],
    options?: { session?: ClientSession },
  ): Promise<<%= name %>[]>;

  abstract update(
    id: <%= name %>['id'],
    payload: DeepPartial<<%= name %>>,
    options?: { session?: ClientSession },
  ): Promise<<%= name %> | null>;

  abstract remove(
    id: <%= name %>['id'],
    options?: { session?: ClientSession },
  ): Promise<void>;
}
