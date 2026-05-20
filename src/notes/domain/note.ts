import { ApiProperty } from '@nestjs/swagger';

export class Note {
  @ApiProperty({ example: '60d0fe4f5311236168a109ca' })
  id: string;

  @ApiProperty({ example: 'tenant_1' })
  tenantId: string;

  @ApiProperty({ example: '60d0fe4f5311236168a109cb' })
  contactId: string;

  @ApiProperty({ example: 'Discovery call' })
  title: string;

  @ApiProperty({ example: 'Customer asked about pricing.' })
  content: string;

  @ApiProperty({ type: 'string' })
  createdById: string;

  @ApiProperty({ type: 'string' })
  updatedById: string;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;

  @ApiProperty()
  deletedAt?: Date;
}
