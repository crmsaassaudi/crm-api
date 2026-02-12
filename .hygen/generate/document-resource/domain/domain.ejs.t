---
to: src/<%= h.inflection.transform(name, ['pluralize', 'underscore', 'dasherize']) %>/domain/<%= h.inflection.transform(name, ['underscore', 'dasherize']) %>.ts
---
import { ApiProperty } from '@nestjs/swagger';

export class <%= name %> {
  id: string;

  // Domain chỉ nói chuyện bằng ngôn ngữ "version"
  version: number;

  createdAt: Date;
  updatedAt: Date;
  tenantId: string;
}
