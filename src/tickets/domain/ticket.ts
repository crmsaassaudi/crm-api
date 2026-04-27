import { ApiProperty } from '@nestjs/swagger';
import { User } from '../../users/domain/user';

export class Ticket {
  @ApiProperty({ example: '60d0fe4f5311236168a109ce' })
  id: string;

  @ApiProperty({ example: 'tenant_1' })
  tenantId: string;

  @ApiProperty({ example: 'TKT-00001' })
  ticketNumber: string;

  @ApiProperty({ example: 'Login page throwing 500 error' })
  subject: string;

  @ApiProperty({ example: 'Detailed description of the issue' })
  description: string;

  // ── Customer Context ──
  @ApiProperty({ description: 'Contact who raised the ticket' })
  contactId?: string;

  @ApiProperty({ description: 'Account the ticket belongs to' })
  accountId?: string;

  @ApiProperty({
    description: 'Omni-conversation this ticket was created from',
  })
  omniConversationId?: string;

  @ApiProperty({ description: 'Linked message IDs from the omni-conversation' })
  linkedMessageIds?: string[];

  @ApiProperty()
  relatedTo?: {
    type: string;
    _id: string;
    name: string;
  };

  // ── Classification & Routing ──
  @ApiProperty({ description: 'ObjectId ref to TicketType collection' })
  typeId: string;

  @ApiProperty({ description: 'Populated ticket type' })
  ticketType?: { id: string; name: string; apiName: string; color?: string };

  @ApiProperty({ description: 'N-level category path as array of node IDs' })
  categoryPath?: string[];

  @ApiProperty({ example: 'HIGH' })
  priority: string;

  @ApiProperty({ example: 'email' })
  channel?: string;

  @ApiProperty({ description: 'ObjectId ref to TicketSource collection' })
  sourceId?: string;

  @ApiProperty({ description: 'Populated ticket source' })
  ticketSource?: { id: string; name: string };

  @ApiProperty({ example: ['billing'] })
  tags?: string[];

  @ApiProperty()
  customFields?: Record<string, any>;

  // ── Assignment & Collaboration ──
  @ApiProperty({ description: 'Team/Queue assigned' })
  groupId?: string;

  @ApiProperty()
  group?: any;

  @ApiProperty()
  ownerId?: string;

  @ApiProperty()
  owner?: User;

  @ApiProperty({ description: 'User IDs watching this ticket' })
  watchers?: string[];

  @ApiProperty({ description: 'ObjectId ref to TicketStatus collection' })
  statusId: string;

  @ApiProperty({ description: 'Populated ticket status' })
  ticketStatus?: {
    id: string;
    label: string;
    apiName: string;
    color?: string;
    isDefault?: boolean;
    isTerminal?: boolean;
  };

  // ── SLA Management ──
  @ApiProperty()
  slaPolicyId?: string;

  @ApiProperty()
  firstResponseDueAt?: Date;

  @ApiProperty()
  resolutionDueAt?: Date;

  @ApiProperty({ example: false })
  isSlaBreached: boolean;

  // ── Metrics & Resolution ──
  @ApiProperty({
    description: 'ObjectId ref to TicketResolutionCode collection',
  })
  resolutionCodeId?: string;

  @ApiProperty({ description: 'Populated resolution code' })
  ticketResolution?: { id: string; name: string; apiName: string };

  @ApiProperty({ description: 'Internal notes when closing ticket' })
  resolutionNotes?: string;

  @ApiProperty({ example: 5 })
  csatScore?: number;

  @ApiProperty({ example: 3600 })
  timeSpentSeconds?: number;

  // ── Timestamps & Audit ──
  @ApiProperty()
  firstRespondedAt?: Date;

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
