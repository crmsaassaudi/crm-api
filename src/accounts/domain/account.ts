import { ApiProperty } from '@nestjs/swagger';
import { User } from '../../users/domain/user';

export class Account {
  @ApiProperty({ example: '60d0fe4f5311236168a109cc' })
  id: string;

  @ApiProperty({ example: 'tenant_1' })
  tenant: string;

  @ApiProperty({ example: 'Acme Corp' })
  name: string;

  @ApiProperty({ example: 'https://acme.com' })
  website?: string;

  @ApiProperty({ example: 'Technology' })
  industry?: string;

  @ApiProperty({ example: 'Customer' })
  type?: string;

  @ApiProperty({ example: ['info@acme.com'] })
  emails?: string[];

  @ApiProperty({ example: ['+1 800 555 0000'] })
  phones?: string[];

  @ApiProperty({ example: 'TAX-123456' })
  taxId?: string;

  @ApiProperty({ example: 5000000 })
  annualRevenue?: number;

  @ApiProperty({ example: 250 })
  numberOfEmployees?: number;

  @ApiProperty({ example: '123 Business Blvd, Tech City' })
  billingAddress?: string;

  @ApiProperty({ example: '456 Logistics Way, Delivery Town' })
  shippingAddress?: string;

  @ApiProperty({ type: 'string' })
  owner?: User | string;

  @ApiProperty({ example: 'active' })
  status?: string;

  @ApiProperty({ example: false })
  isArchived?: boolean;

  @ApiProperty()
  customFields?: Record<string, any>;

  @ApiProperty({ example: ['VIP'] })
  tags?: string[];

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;

  @ApiProperty()
  deletedAt?: Date;
}
