---
to: src/<%= h.inflection.transform(name, ['pluralize', 'underscore', 'dasherize']) %>/dto/update-<%= h.inflection.transform(name, ['underscore', 'dasherize']) %>.dto.ts
---
// Don't forget to use the class-validator decorators in the DTO properties.
// import { Allow } from 'class-validator';

import { ApiProperty, PartialType } from '@nestjs/swagger';
import { IsNumber, IsOptional } from 'class-validator';
import { Create<%= name %>Dto } from './create-<%= h.inflection.transform(name, ['underscore', 'dasherize']) %>.dto';

export class Update<%= name %>Dto extends PartialType(Create<%= name %>Dto) {
  @ApiProperty({ required: false, description: 'Version for optimistic concurrency control' })
  @IsOptional()
  @IsNumber()
  version?: number;
}
