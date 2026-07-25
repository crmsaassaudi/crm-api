import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AbacCondition, PolicyEffect } from '../abac.evaluator';

/** AccessPolicy — a tenant-scoped ABAC rule layered on top of RBAC. */
export class AccessPolicy {
  @ApiProperty({ example: '507f1f77bcf86cd799439011' })
  id: string;

  @ApiProperty({ example: '507f1f77bcf86cd799439011' })
  tenantId: string;

  @ApiProperty({ example: 'Lock closed deals' })
  name: string;

  @ApiProperty({ example: '' })
  description: string;

  @ApiProperty({ example: 'deals' })
  resource: string;

  @ApiProperty({ example: 'edit' })
  action: string;

  @ApiProperty({ example: 'deny', enum: ['allow', 'deny'] })
  effect: PolicyEffect;

  @ApiProperty({ type: 'array', items: { type: 'object' } })
  conditions: AbacCondition[];

  @ApiProperty({ example: true })
  active: boolean;

  @ApiProperty({ example: 100 })
  priority: number;

  @ApiPropertyOptional()
  createdAt?: Date;

  @ApiPropertyOptional()
  updatedAt?: Date;
}
