---
to: src/<%= h.inflection.transform(name, ['pluralize', 'underscore', 'dasherize']) %>/domain/<%= h.inflection.transform(name, ['underscore', 'dasherize']) %>.ts
---
import { ApiProperty } from '@nestjs/swagger';

export class <%= name %> {
  id: string;
  version: number;
  tenantId: string;
  createdAt: Date;
  updatedAt: Date;
}
