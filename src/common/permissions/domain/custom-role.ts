import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DATA_SCOPE_ORDER, DataScope } from '../data-scope.enum';

/**
 * CustomRole — a named, reusable permission set inside one tenant.
 *
 * Response shape for the role catalogue. `id` is a string, never a BSON
 * ObjectId: handing a hydrated Mongoose document (or a raw ObjectId) to the
 * global response pipeline breaks it — ClassSerializerInterceptor walks the
 * document internals and throws, and it flattens an ObjectId into `{}`.
 */
export class CustomRole {
  @ApiProperty({ example: '507f1f77bcf86cd799439011' })
  id: string;

  @ApiProperty({ example: '507f1f77bcf86cd799439011' })
  tenantId: string;

  @ApiProperty({ example: 'Sales Rep' })
  name: string;

  @ApiProperty({ example: 'Work leads, contacts, accounts and deals.' })
  description: string;

  @ApiProperty({ example: ['contacts:view', 'deals:create'], type: [String] })
  permissions: string[];

  @ApiProperty({
    example: true,
    description:
      'Materialised from a system template — immutable, clone to customise.',
  })
  isSystem: boolean;

  @ApiPropertyOptional({
    example: 'sys.sales_rep',
    description: 'Stable template key; null on tenant-authored roles.',
  })
  systemKey?: string | null;

  @ApiPropertyOptional({ example: 1 })
  templateVersion?: number | null;

  @ApiPropertyOptional({
    enum: DATA_SCOPE_ORDER,
    nullable: true,
    description:
      'Read breadth this role grants inside the tenant. Null = no opinion; the tenant default applies. A user with several roles gets the widest.',
  })
  dataScope?: DataScope | null;

  @ApiProperty({ example: '#6366f1' })
  color: string;

  @ApiPropertyOptional()
  createdAt?: Date;

  @ApiPropertyOptional()
  updatedAt?: Date;
}
