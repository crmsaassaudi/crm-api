import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * OrgUnit response shape. `id` and every reference are plain strings, never
 * BSON ObjectIds — handing a hydrated document or a raw ObjectId to the global
 * response pipeline breaks it (ClassSerializerInterceptor walks the document
 * internals and throws, and it flattens an ObjectId into `{}`).
 */
export class OrgUnit {
  @ApiProperty({ example: '507f1f77bcf86cd799439011' })
  id: string;

  @ApiProperty({ example: '507f1f77bcf86cd799439011' })
  tenantId: string;

  @ApiProperty({ example: 'Sales — North' })
  name: string;

  @ApiPropertyOptional({ example: 'SALES-NORTH', nullable: true })
  code?: string | null;

  @ApiPropertyOptional({ nullable: true })
  description?: string | null;

  @ApiProperty({ example: '507f1f77bcf86cd799439011', nullable: true })
  parentId: string | null;

  @ApiProperty({
    example: '/507f1f77bcf86cd799439010/507f1f77bcf86cd799439011/',
    description:
      'Materialised ancestor path, self included. Server-maintained; read-only.',
  })
  path: string;

  @ApiProperty({ example: 1, description: 'Ancestor count. Server-derived.' })
  depth: number;

  @ApiPropertyOptional({ example: '507f1f77bcf86cd799439011', nullable: true })
  managerId?: string | null;

  @ApiProperty({
    type: [String],
    description:
      'Co-managers of this unit. The primary `managerId` is always included ' +
      'in the effective manager set, whether or not it is repeated here.',
  })
  managerIds: string[];

  @ApiProperty({ example: true })
  isActive: boolean;

  @ApiPropertyOptional()
  createdAt?: Date;

  @ApiPropertyOptional()
  updatedAt?: Date;
}

/** A manager as the org-chart UI needs to render them. */
export class OrgUnitManagerRef {
  @ApiProperty()
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty({ description: "The unit's primary head (`managerId`)." })
  isPrimary: boolean;
}

/** One node of the tree response, with its children nested. */
export class OrgUnitTreeNode extends OrgUnit {
  @ApiProperty({ type: () => [OrgUnitTreeNode] })
  children: OrgUnitTreeNode[];

  @ApiProperty({
    type: () => [OrgUnitManagerRef],
    description:
      'Primary head plus co-managers, with names resolved. Included because ' +
      'the ids alone are unrenderable and the client has no user list to join ' +
      'them against.',
  })
  managers: OrgUnitManagerRef[];

  @ApiProperty({
    example: 4,
    description: 'Users whose orgUnitId is this node. Excludes descendants.',
  })
  memberCount: number;
}
