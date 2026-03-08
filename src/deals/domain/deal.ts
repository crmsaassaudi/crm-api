import { ApiProperty } from '@nestjs/swagger';

export class Deal {
  @ApiProperty({ example: '60d0fe4f5311236168a109cd' })
  id: string;

  @ApiProperty({ example: 'tenant_1' })
  tenant: string;

  @ApiProperty({ example: 'Enterprise Software License' })
  title: string;

  @ApiProperty({ example: 'Enterprise Software License' })
  name: string;

  @ApiProperty({ example: 'default' })
  pipeline: string;

  @ApiProperty({ example: 'qualification' })
  stage: string;

  @ApiProperty({ example: 50 })
  probability?: number;

  @ApiProperty({ example: 25000 })
  value: number;

  @ApiProperty({ example: 'USD' })
  currency: string;

  @ApiProperty({ example: '60d0fe4f5311236168a109cc' })
  accountId?: string;

  @ApiProperty({ example: 'Acme Corp' })
  accountName?: string;

  @ApiProperty()
  contactIds?: string[];

  @ApiProperty()
  owner?: string;

  @ApiProperty({ example: 'Full scope project for Acme Corp' })
  description?: string;

  @ApiProperty({ example: 'Inbound' })
  source?: string;

  @ApiProperty({ example: 'Budget constraint' })
  lostReason?: string;

  @ApiProperty({ example: ['enterprise'] })
  tags?: string[];

  @ApiProperty()
  customFields?: Record<string, any>;

  @ApiProperty()
  closeDate?: Date;

  @ApiProperty()
  wonAt?: Date;

  @ApiProperty()
  lostAt?: Date;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;

  @ApiProperty()
  deletedAt?: Date;
}
