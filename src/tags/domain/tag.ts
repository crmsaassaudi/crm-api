import { ApiProperty } from '@nestjs/swagger';

export class Tag {
  @ApiProperty({ example: '507f1f77bcf86cd799439011' })
  id: string;

  @ApiProperty({ example: 'tenant_1' })
  tenantId: string;

  @ApiProperty({ example: 'VIP' })
  name: string;

  @ApiProperty({ example: '#ef4444' })
  color: string;

  @ApiProperty({ example: 'Contact' })
  scope: string;

  @ApiProperty({ example: 0 })
  order: number;

  @ApiProperty({ example: [], type: [String] })
  channelIds: string[];

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}
