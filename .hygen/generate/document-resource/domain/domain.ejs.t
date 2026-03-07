---
to: src/<%= h.inflection.transform(name, ['pluralize', 'underscore', 'dasherize']) %>/domain/<%= h.inflection.transform(name, ['underscore', 'dasherize']) %>.ts
---
import { ApiProperty } from '@nestjs/swagger';
import { User } from '../../users/domain/user';

export class <%= name %> {
  @ApiProperty({ example: '60d0fe4f5311236168a109ca' })
  id: string;

  @ApiProperty({ example: '60d0fe4f5311236168a109cb' })
  tenant: string;

  // Do not remove comment below.
  // <domain-property />

  /**
   * References: string (ObjectId) when creating, populated User object when reading.
   */
  @ApiProperty({ type: 'string' })
  createdBy: User | string;

  @ApiProperty({ type: 'string' })
  updatedBy: User | string;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;

  @ApiProperty()
  deletedAt?: Date;

  version?: number;
}
