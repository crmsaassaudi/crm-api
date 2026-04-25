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

  /**
   * @deprecated Use `lifecycleStage` instead. Kept for backward compatibility.
   * Will be removed in a future version.
   */
  @ApiProperty({ example: false, deprecated: true })
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

  @ApiProperty({ example: 'CEO' })
  role?: string;

  @ApiProperty({ example: '123 Main St' })
  address?: string;

  @ApiProperty({ example: '1990-01-01' })
  birthday?: Date;

  @ApiProperty({ example: { custom_1: 'value' } })
  customFields?: Record<string, any>;

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

  @ApiProperty({
    example: [{ channelType: 'Facebook', senderId: 'psid_123456' }],
  })
  omniIdentities?: Array<{ channelType: string; senderId: string }>;

  @ApiProperty({ example: true })
  isShadow?: boolean;

  @ApiProperty({
    example: false,
    description: 'VIP customer flag for priority routing',
  })
  isVIP?: boolean;

  @ApiProperty({
    example: [],
    description: 'Log of all lifecycle stage transitions',
  })
  stageHistory?: Array<{
    fromStage: string | null;
    toStage: string;
    changedAt: Date;
    changedById: string;
    reason?: string;
  }>;
}
