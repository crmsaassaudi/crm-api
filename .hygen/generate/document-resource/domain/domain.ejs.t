---
to: src/<%= h.inflection.transform(name, ['pluralize', 'underscore', 'dasherize']) %>/domain/<%= h.inflection.transform(name, ['underscore', 'dasherize']) %>.ts
---
import { ApiProperty } from '@nestjs/swagger';
import { User } from '../../users/domain/user';

export class <%= name %> {
  @ApiProperty({ example: '60d0fe4f5311236168a109ca' })
  id: string;

  @ApiProperty({ example: '60d0fe4f5311236168a109cb' })
  tenantId: string;

  // Do not remove comment below.
  // <domain-property />

  /**
    * Internal references must use Id suffix.
   */
  @ApiProperty({ type: 'string' })
    createdById: string;

  @ApiProperty({ type: 'string' })
    updatedById: string;

    @ApiProperty({ type: () => User, required: false })
    createdBy?: User;

    @ApiProperty({ type: () => User, required: false })
    updatedBy?: User;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;

  @ApiProperty()
  deletedAt?: Date;

  version?: number;
}
