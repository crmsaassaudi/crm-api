import { ApiProperty } from '@nestjs/swagger';
import { User } from '../../users/domain/user';

export class Deal {
  @ApiProperty({ example: '60d0fe4f5311236168a109cd' })
  id: string;

  @ApiProperty({ example: 'tenant_1' })
  tenantId: string;

  @ApiProperty({ example: 'Enterprise Software License' })
  title: string;

  @ApiProperty({ example: 'Enterprise Software License' })
  name: string;

  @ApiProperty({ example: 'default' })
  pipeline: string;

  @ApiProperty({ example: 'qualification' })
  stageId: string;

  @ApiProperty()
  dealStage?: {
    id: string;
    label: string;
    apiName: string;
    color: string;
    probability: number;
    isWon: boolean;
    isLost: boolean;
  };

  @ApiProperty({ example: 50 })
  probability?: number;

  @ApiProperty({ example: 25000 })
  value: number;

  @ApiProperty({ example: 'USD' })
  currency: string;

  @ApiProperty({ example: '60d0fe4f5311236168a109cc' })
  accountId?: string;

  @ApiProperty({ example: 'Acme Corp' })
  accountName?: string;

  @ApiProperty()
  contactIds?: string[];

  @ApiProperty()
  ownerId?: string;

  @ApiProperty({ type: () => User })
  owner?: User;

  @ApiProperty({ example: 'Full scope project for Acme Corp' })
  description?: string;

  @ApiProperty({ example: 'Inbound' })
  sourceId?: string;

  @ApiProperty()
  dealSource?: { id: string; name: string };

  @ApiProperty({ example: 'Budget constraint' })
  lostReason?: string;

  @ApiProperty({ example: ['enterprise'] })
  tags?: string[];

  @ApiProperty()
  customFields?: Record<string, any>;

  @ApiProperty()
  closeDate?: Date;

  @ApiProperty()
  wonAt?: Date;

  @ApiProperty()
  lostAt?: Date;

  @ApiProperty()
  createdById?: string;

  @ApiProperty()
  updatedById?: string;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;

  @ApiProperty()
  deletedAt?: Date;

  @ApiProperty({ description: 'Omni-conversation this deal was created from' })
  omniConversationId?: string;

  @ApiProperty({ description: 'Linked message IDs from the omni-conversation' })
  linkedMessageIds?: string[];

  // NO `ticketIds`.
  //
  // It was declared here, absent from DealSchemaClass, and read by nothing —
  // `linkDeal`'s comment even claimed it appended to it. The deal's tickets are found by
  // querying `tickets.dealId` (GET /tickets/by-deal/:dealId), which is one source of
  // truth; a mirrored array would need maintaining on every link, unlink and merge, and
  // would silently disagree with the FK the first time one of those was missed.
}
