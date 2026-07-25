import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  AuthzAuditAction,
  AuthzAuditCategory,
} from '../authz-audit-log.schema';

/** One append-only authorization-governance event. */
export class AuthzAuditLog {
  @ApiProperty({ example: '507f1f77bcf86cd799439011' })
  id: string;

  @ApiProperty({ example: '507f1f77bcf86cd799439011' })
  tenantId: string;

  @ApiProperty({ example: '507f1f77bcf86cd799439012' })
  actorId: string;

  @ApiPropertyOptional({ example: 'admin@acme.com' })
  actorEmail?: string | null;

  @ApiPropertyOptional({ example: 'user' })
  actorType?: string;

  @ApiProperty({ example: 'ROLE' })
  category: AuthzAuditCategory;

  @ApiProperty({ example: 'update' })
  action: AuthzAuditAction;

  @ApiProperty({ example: 'custom_role' })
  targetType: string;

  @ApiProperty({ example: '507f1f77bcf86cd799439013' })
  targetId: string;

  @ApiPropertyOptional({ example: 'updated role "Sales Rep"' })
  summary?: string | null;

  @ApiPropertyOptional()
  before?: any;

  @ApiPropertyOptional()
  after?: any;

  @ApiPropertyOptional({ example: '203.0.113.4' })
  ip?: string | null;

  @ApiProperty({ description: 'Append time' })
  t: Date;
}
