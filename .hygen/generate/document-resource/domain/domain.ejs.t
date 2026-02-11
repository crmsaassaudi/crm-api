---
to: src/<%= h.inflection.transform(name, ['pluralize', 'underscore', 'dasherize']) %>/domain/<%= h.inflection.transform(name, ['underscore', 'dasherize']) %>.ts
---
import { ApiProperty } from '@nestjs/swagger';

export class BaseDomain {
  id: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export class <%= name %> extends BaseDomain {
}
