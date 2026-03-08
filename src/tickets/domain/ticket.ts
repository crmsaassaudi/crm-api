import { ApiProperty } from '@nestjs/swagger';

export class Ticket {
  @ApiProperty({ example: '60d0fe4f5311236168a109ce' })
  id: string;

  @ApiProperty({ example: 'tenant_1' })
  tenant: string;

  @ApiProperty({ example: 'TKT-00001' })
  ticketNumber: string;

  @ApiProperty({ example: 'Login page throwing 500 error' })
  subject: string;

  @ApiProperty({ example: 'Detailed description of the issue' })
  description: string;

  @ApiProperty({ example: '60d0fe4f5311236168a109ca' })
  requester?: string;

  @ApiProperty({ example: '60d0fe4f5311236168a109cb' })
  assignee?: string;

  @ApiProperty({ example: 'new' })
  status: string;

  @ApiProperty({ example: 'HIGH' })
  priority: string;

  @ApiProperty({ example: 'new' })
  lifecycleStage?: string;

  @ApiProperty({ example: 'email' })
  channel?: string;

  @ApiProperty({ example: 'web' })
  source?: string;

  @ApiProperty()
  relatedTo?: {
    type: string;
    _id: string;
    name: string;
  };

  @ApiProperty({ example: false })
  slaBreached?: boolean;

  @ApiProperty({ example: ['billing'] })
  tags?: string[];

  @ApiProperty()
  customFields?: Record<string, any>;

  @ApiProperty()
  resolvedAt?: Date;

  @ApiProperty()
  closedAt?: Date;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;

  @ApiProperty()
  deletedAt?: Date;
}
