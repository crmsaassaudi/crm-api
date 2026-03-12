import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class Group {
  @ApiProperty({ example: '507f1f77bcf86cd799439011' })
  id: string;

  @ApiProperty({ example: 'tenant_1' })
  tenant: string;

  @ApiProperty({ example: 'Sales Team' })
  name: string;

  @ApiPropertyOptional({ example: 'Main sales department' })
  description?: string;

  @ApiPropertyOptional({
    example: '507f1f77bcf86cd799439011',
    nullable: true,
  })
  parentGroup: string | null;

  @ApiPropertyOptional({ example: '507f1f77bcf86cd799439011', nullable: true })
  manager?: string | null;

  @ApiProperty({ type: [String] })
  members: string[];

  @ApiProperty({ type: [String], example: ['leads:view', 'leads:create'] })
  permissions: string[];

  @ApiProperty({ example: true })
  isActive: boolean;

  @ApiPropertyOptional({ example: '#3b82f6' })
  color?: string | null;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}
