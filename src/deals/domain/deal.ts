import { ApiProperty } from '@nestjs/swagger';
import { User } from '../../users/domain/user';
import { DealStageHistoryItem, DealStageSummary } from './deal-stage-summary';

export { DealStageHistoryItem, DealStageSummary };

export class Deal {
  @ApiProperty({ example: '60d0fe4f5311236168a109cd' })
  id: string;

  @ApiProperty({ example: 'tenant_1' })
  tenantId: string;

  @ApiProperty({ example: 'Enterprise Software License' })
  title: string;

  @ApiProperty({ example: 'Enterprise Software License' })
  name: string;

  @ApiProperty({ example: '60d0fe4f5311236168a109ce' })
  pipelineId: string;

  @ApiProperty({ description: 'Pipeline name, populated on read' })
  pipelineName?: string;

  @ApiProperty({ example: '60d0fe4f5311236168a109cf' })
  stageId: string;

  @ApiProperty({ type: () => DealStageSummary })
  dealStage?: DealStageSummary;

  @ApiProperty({ type: () => [DealStageHistoryItem] })
  stageHistory?: DealStageHistoryItem[];

  @ApiProperty({ description: 'When the deal entered its current stage' })
  stageEnteredAt?: Date;

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

  @ApiProperty({
    description: 'True when a human chose the owner rather than it defaulting.',
  })
  ownerAssignedExplicitly?: boolean;

  @ApiProperty({
    description:
      'Set when the owner left the tenant and ownership was cleared automatically.',
  })
  unassignedReason?: string | null;

  @ApiProperty({ type: () => User })
  owner?: User;

  @ApiProperty({ example: 'Full scope project for Acme Corp' })
  description?: string;

  @ApiProperty({ example: '60d0fe4f5311236168a109cd' })
  sourceId?: string;

  @ApiProperty()
  dealSource?: { id: string; name: string };

  @ApiProperty({ example: 'facebook' })
  utmSource?: string | null;

  @ApiProperty({ example: 'cpc' })
  utmMedium?: string | null;

  @ApiProperty({ example: 'ramadan-2026' })
  utmCampaign?: string | null;

  @ApiProperty({ example: 'Budget constraint' })
  lostReason?: string;

  @ApiProperty({ example: ['enterprise'] })
  tags?: string[];

  @ApiProperty()
  customFields?: Record<string, any>;

  @ApiProperty()
  closeDate?: Date;

  @ApiProperty({ description: 'Next committed touch point' })
  nextFollowUpAt?: Date | null;

  @ApiProperty({ description: 'Last edit, stage move or logged activity' })
  lastActivityAt?: Date;

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

  // Mongoose's versionKey (`__v`), exposed under the same name every other
  // domain in this codebase uses for it. The base repository does an
  // optimistic (version-checked) `findOneAndUpdate` when this is present on
  // the payload — round-trip it from a GET back through a PATCH to get a 409
  // instead of a silently lost concurrent update.
  @ApiProperty({ description: 'Optimistic-concurrency version token' })
  version?: number;

  @ApiProperty({ description: 'Omni-conversation this deal was created from' })
  omniConversationId?: string;

  @ApiProperty({ description: 'Linked message IDs from the omni-conversation' })
  linkedMessageIds?: string[];
}
