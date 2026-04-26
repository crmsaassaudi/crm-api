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
  @ApiProperty({
    example: '60d0fe4f5311236168a109ca',
    description: 'Contact who raised the ticket',
  })
  contactId?: string;

  @ApiProperty({
    example: '60d0fe4f5311236168a109cb',
    description: 'Account the ticket belongs to',
  })
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
  @ApiProperty({
    example: 'Incident',
    description: 'Incident, Question, Request, Problem, Task',
  })
  type: string;

  @ApiProperty({
    example: 'Technical',
    description: 'Billing, Technical, Sales',
  })
  category?: string;

  @ApiProperty({ example: 'Server Down' })
  subCategory?: string;

  @ApiProperty({ example: 'HIGH' })
  priority: string;

  @ApiProperty({ example: 'email' })
  channel?: string;

  @ApiProperty({ example: 'web' })
  source?: string;

  @ApiProperty({ example: ['billing'] })
  tags?: string[];

  @ApiProperty()
  customFields?: Record<string, any>;

  // ── Assignment & Collaboration ──
  @ApiProperty({ description: 'Team/Queue assigned to handle this ticket' })
  groupId?: string;

  @ApiProperty()
  group?: any;

  @ApiProperty({ type: 'string', example: '60d0fe4f5311236168a109cc' })
  ownerId?: string;

  @ApiProperty()
  owner?: User;

  @ApiProperty({ description: 'User IDs watching this ticket' })
  watchers?: string[];

  @ApiProperty({ example: 'new' })
  status: string;

  // ── SLA Management ──
  @ApiProperty({ description: 'SLA Policy applied to this ticket' })
  slaPolicyId?: string;

  @ApiProperty({ description: 'Deadline for first response' })
  firstResponseDueAt?: Date;

  @ApiProperty({ description: 'Deadline for resolution' })
  resolutionDueAt?: Date;

  @ApiProperty({ example: false })
  isSlaBreached: boolean;

  // ── Metrics & Resolution ──
  @ApiProperty({
    example: 'Fixed',
    description: 'Fixed, Duplicate, Wont_Fix, User_Error',
  })
  resolutionCode?: string;

  @ApiProperty({ description: 'Internal notes when closing ticket' })
  resolutionNotes?: string;

  @ApiProperty({ example: 5, description: 'Customer Satisfaction score (1-5)' })
  csatScore?: number;

  @ApiProperty({
    example: 3600,
    description: 'Total time agent spent working on ticket (seconds)',
  })
  timeSpentSeconds?: number;

  // ── Timestamps & Audit ──
  @ApiProperty({ description: 'When agent first responded' })
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
