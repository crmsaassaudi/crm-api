import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AssignmentPrincipalType } from '../role-assignment.schema';

/** RoleAssignment — an auditable, optionally time-bound grant of a role. */
export class RoleAssignment {
  @ApiProperty({ example: '507f1f77bcf86cd799439011' })
  id: string;

  @ApiProperty({ example: '507f1f77bcf86cd799439011' })
  tenantId: string;

  @ApiProperty({ example: 'user', enum: ['user', 'group'] })
  principalType: AssignmentPrincipalType;

  @ApiProperty({ example: '507f1f77bcf86cd799439012' })
  principalId: string;

  @ApiProperty({ example: '507f1f77bcf86cd799439013' })
  roleId: string;

  @ApiProperty({ example: '507f1f77bcf86cd799439014' })
  grantedById: string;

  @ApiPropertyOptional({ description: 'null → permanent grant' })
  expiresAt?: Date | null;

  @ApiPropertyOptional({ example: 'On-call escalation #4821' })
  reason?: string | null;

  @ApiPropertyOptional({ description: 'Set on revoke (soft)' })
  revokedAt?: Date | null;

  @ApiPropertyOptional()
  revokedById?: string | null;

  @ApiPropertyOptional()
  createdAt?: Date;

  @ApiPropertyOptional()
  updatedAt?: Date;
}
