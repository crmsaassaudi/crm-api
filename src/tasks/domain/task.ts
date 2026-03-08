import { ApiProperty } from '@nestjs/swagger';

export class Task {
  @ApiProperty({ example: '60d0fe4f5311236168a109cf' })
  id: string;

  @ApiProperty({ example: 'tenant_1' })
  tenant: string;

  @ApiProperty({ example: 'Follow up with new lead' })
  title: string;

  @ApiProperty({ example: 'Call John Doe regarding his interest' })
  description?: string;

  @ApiProperty({ example: '2026-03-15T10:00:00Z' })
  dueDate: Date;

  @ApiProperty({ example: 'not_started' })
  status: string;

  @ApiProperty({ example: 'HIGH' })
  priority: string;

  @ApiProperty({ example: 'call' })
  category: string;

  @ApiProperty({ example: '60d0fe4f5311236168a109cb' })
  assignedTo?: string;

  @ApiProperty()
  relatedTo?: {
    type: string;
    _id: string;
    name: string;
  };

  @ApiProperty({ example: ['follow-up'] })
  tags?: string[];

  @ApiProperty()
  reminderAt?: Date;

  @ApiProperty()
  completedAt?: Date;

  @ApiProperty({ example: 'manual' })
  source?: string;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;

  @ApiProperty()
  deletedAt?: Date;
}
