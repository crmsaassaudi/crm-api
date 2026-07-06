import { ApiProperty } from '@nestjs/swagger';

export class ActivityLog {
  @ApiProperty({ example: '60d0fe4f5311236168a109ca' })
  id: string;

  @ApiProperty({ example: 'tenant_1' })
  tenantId: string;

  @ApiProperty({ example: 'contact' })
  targetType: string;

  @ApiProperty({ example: '60d0fe4f5311236168a109cb' })
  targetId: string;

  @ApiProperty({ example: 'stage_change' })
  event: string;

  @ApiProperty({ required: false })
  actorId?: string;

  @ApiProperty({ required: false })
  actor?: any;

  @ApiProperty({ required: false })
  payload?: Record<string, any>;

  @ApiProperty()
  occurredAt: Date;

  @ApiProperty()
  createdAt?: Date;

  @ApiProperty()
  updatedAt?: Date;
}
