import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DATA_SCOPE_ORDER, DataScope } from '../data-scope.enum';

/**
 * What the frontend renders permission-dependent UI from. Deliberately includes
 * the ceiling as well as the grant, because the two need different UI: a key
 * outside `tenantCeiling` is unavailable on this plan (asking an admin will not
 * help), while a key inside the ceiling but absent from `permissions` is simply
 * not granted yet (asking an admin is exactly the right advice).
 */
export class MyPermissionsResponse {
  @ApiProperty({ example: '507f1f77bcf86cd799439011' })
  userId: string;

  @ApiProperty({
    example: '507f1f77bcf86cd799439011',
    nullable: true,
    description:
      'Null when no workspace is active (onboarding, or no membership).',
  })
  tenantId: string | null;

  @ApiProperty({
    type: [String],
    example: ['contacts:view', 'deals:create'],
    description:
      'Effective permission keys. Accounts for roleIds, group and ancestor-group roles, JIT grants, direct grants, overrides and the tenant ceiling.',
  })
  permissions: string[];

  @ApiProperty({
    type: [String],
    description:
      'The widest set this tenant could ever grant (core minus disabled, plus purchased features).',
  })
  tenantCeiling: string[];

  @ApiProperty({
    example: false,
    description:
      'True for tenant owner / ADMIN / platform super-admin, who hold the whole ceiling.',
  })
  fullAccess: boolean;

  @ApiPropertyOptional({ enum: ['owner', 'admin', 'super_admin'] })
  fullAccessReason?: 'owner' | 'admin' | 'super_admin';

  @ApiProperty({
    enum: DATA_SCOPE_ORDER,
    example: DataScope.SUBORDINATES,
    description:
      'How many records the caller can read. Informational for the client — the server enforces it regardless.',
  })
  dataScope: DataScope;

  @ApiProperty({ nullable: true, example: '507f1f77bcf86cd799439011' })
  orgUnitId: string | null;
}
