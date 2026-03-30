import { ApiProperty } from '@nestjs/swagger';
import { User } from '../../users/domain/user';

export class Contact {
  @ApiProperty({ example: '60d0fe4f5311236168a109ca' })
  id: string;

  @ApiProperty({ example: 'tenant_1' })
  tenantId: string;

  @ApiProperty({ example: 'John' })
  firstName: string;

  @ApiProperty({ example: 'Doe' })
  lastName: string;

  emails: string[];

  @ApiProperty({ example: ['+15551234567'] })
  phones: string[];

  @ApiProperty({ example: false })
  isConverted: boolean;

  @ApiProperty({ example: 'lead' })
  lifecycleStage: string;

  @ApiProperty({ example: 'new' })
  status: string;

  @ApiProperty({ example: 'Acme Corp' })
  companyName?: string;

  @ApiProperty({ example: '60d0fe4f5311236168a109cb' })
  accountId?: string;

  @ApiProperty({ example: 'Sales Manager' })
  title?: string;

  @ApiProperty({ example: '1' })
  source?: string;

  @ApiProperty({ example: 50 })
  score?: number;

  @ApiProperty({ type: 'string', example: '60d0fe4f5311236168a109cc' })
  ownerId?: string;

  @ApiProperty()
  owner?: User;

  @ApiProperty({ type: 'string' })
  createdById: string;

  @ApiProperty()
  createdBy?: User;

  @ApiProperty({ type: 'string' })
  updatedById: string;
  
  @ApiProperty()
  updatedBy?: User;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;

  @ApiProperty()
  deletedAt?: Date;

  @ApiProperty({ example: 'psid_123456' })
  omniSenderId?: string;

  @ApiProperty({ example: true })
  isShadow?: boolean;
}
