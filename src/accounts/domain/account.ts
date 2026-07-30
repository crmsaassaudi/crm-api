import { ApiProperty } from '@nestjs/swagger';
import { User } from '../../users/domain/user';

export class Account {
  @ApiProperty({ example: '60d0fe4f5311236168a109cc' })
  id: string;

  @ApiProperty({ example: 'tenant_1' })
  tenantId: string;

  @ApiProperty({ example: 'Acme Corp' })
  name: string;

  @ApiProperty({ example: 'https://acme.com' })
  website?: string;

  @ApiProperty({ example: 'Technology' })
  industry?: string;

  @ApiProperty({ example: 'Customer' })
  typeId?: string;

  @ApiProperty()
  accountType?: { id: string; name: string; apiName: string };

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
  ownerId?: string;

  @ApiProperty({ type: () => User })
  owner?: User;

  /** Org-unit ownership — the second data-visibility axis alongside `ownerId`. */
  @ApiProperty({ type: 'string', nullable: true })
  orgUnitId?: string | null;

  @ApiProperty({ example: 'active' })
  statusId?: string;

  @ApiProperty()
  accountStatus?: { id: string; label: string; apiName: string; color: string };

  @ApiProperty({ example: false })
  isArchived?: boolean;

  // ── Derived identity keys ──
  //
  // Present on the domain model, not just the schema, because `update()` writes
  // through `AccountMapper.toPersistence` and only carries fields the mapper knows
  // about. While these three were schema-only, `AccountsService.update` derived them
  // on every PATCH and the mapper dropped them on the floor: renaming a company left
  // its old `nameKey` in place, so duplicate detection went on comparing the previous
  // name forever. Create was unaffected (it bypasses the mapper), which is why the gap
  // looked like it worked.

  @ApiProperty({ example: 'acme' })
  nameKey?: string;

  @ApiProperty({ example: 'acme.com' })
  websiteDomain?: string;

  @ApiProperty({ example: 'TAX123456' })
  taxIdKey?: string;

  /** Mongo `__v`, for the optimistic check on merge. */
  @ApiProperty({ example: 0 })
  version?: number;

  @ApiProperty()
  customFields?: Record<string, any>;

  @ApiProperty({ example: ['VIP'] })
  tags?: string[];

  @ApiProperty()
  createdById?: string;

  @ApiProperty()
  updatedById?: string;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;

  @ApiProperty()
  deletedAt?: Date;
}
