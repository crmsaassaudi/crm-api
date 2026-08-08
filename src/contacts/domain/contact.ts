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

  @ApiProperty({
    example: 'John Doe',
    description: 'Computed from firstName + lastName',
  })
  name?: string;

  emails: string[];

  @ApiProperty({ example: ['+15551234567'] })
  phones: string[];

  @ApiProperty({ example: 'lead' })
  lifecycleStageId: string;

  @ApiProperty({ example: 'new' })
  statusId: string;

  @ApiProperty({ example: 'Acme Corp' })
  companyName?: string;

  @ApiProperty({ example: '60d0fe4f5311236168a109cb' })
  accountId?: string;

  @ApiProperty({ example: 'Sales Manager' })
  title?: string;

  @ApiProperty({ example: '1' })
  sourceId?: string;

  @ApiProperty({ example: 'CEO' })
  role?: string;

  @ApiProperty({ example: '123 Main St' })
  address?: string;

  @ApiProperty({ example: 'Riyadh' })
  city?: string;

  @ApiProperty({
    example: 'SA',
    description: 'ISO-3166-1 alpha-2 country code',
  })
  country?: string;

  @ApiProperty({ example: '1990-01-01' })
  birthday?: Date;

  @ApiProperty({ example: 'shopify_cust_8471' })
  externalId?: string;

  @ApiProperty({ example: 'shopify' })
  externalSource?: string;

  @ApiProperty({ example: 4200, description: 'Sum of won deal value' })
  totalRevenue?: number;

  @ApiProperty({ example: 7 })
  dealsCount?: number;

  @ApiProperty({ example: 3 })
  wonDealsCount?: number;

  @ApiProperty()
  lastPurchaseAt?: Date;

  @ApiProperty()
  firstPurchaseAt?: Date;

  @ApiProperty({ example: { custom_1: 'value' } })
  customFields?: Record<string, any>;

  @ApiProperty({ example: 50 })
  score?: number;

  /** `true` agreed, `false` refused, `null` never asked. */
  @ApiProperty({ example: true, nullable: true })
  emailOptIn?: boolean | null;

  @ApiProperty({ example: null, nullable: true })
  smsOptIn?: boolean | null;

  @ApiProperty({ example: null, nullable: true })
  whatsappOptIn?: boolean | null;

  @ApiProperty({ example: false })
  doNotCall?: boolean;

  @ApiProperty({ example: ['enterprise', 'webinar'] })
  tags?: string[];

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
  lastActivityAt?: Date;

  @ApiProperty()
  deletedAt?: Date;

  @ApiProperty({ required: false })
  version?: number;

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
    direction?: 'forward' | 'backward' | 'lateral';
    skippedStages?: string[];
  }>;
}
