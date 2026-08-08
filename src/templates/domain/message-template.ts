import { ApiProperty } from '@nestjs/swagger';

export const TEMPLATE_PURPOSES = [
  'agent_reply',
  'campaign',
  'automation',
  'bot',
] as const;
export type TemplatePurpose = (typeof TEMPLATE_PURPOSES)[number];

export const TEMPLATE_STATUSES = ['draft', 'published', 'archived'] as const;
export type TemplateStatus = (typeof TEMPLATE_STATUSES)[number];

export const TEMPLATE_VISIBILITIES = ['private', 'team', 'tenant'] as const;
export type TemplateVisibility = (typeof TEMPLATE_VISIBILITIES)[number];

export class MessageTemplate {
  @ApiProperty()
  id: string;

  @ApiProperty()
  tenantId: string;

  @ApiProperty({ example: 'Xác nhận đơn hàng' })
  name: string;

  @ApiProperty({ enum: TEMPLATE_PURPOSES, isArray: true })
  purpose: TemplatePurpose[];

  @ApiProperty({ type: [String] })
  tags: string[];

  @ApiProperty({ enum: TEMPLATE_STATUSES })
  status: TemplateStatus;

  @ApiProperty({ enum: TEMPLATE_VISIBILITIES })
  visibility: TemplateVisibility;

  @ApiProperty()
  ownerId: string;

  @ApiProperty({ required: false, example: '/hi' })
  shortcut?: string;

  @ApiProperty()
  usageCount: number;

  @ApiProperty({ required: false })
  lastUsedAt?: Date;

  @ApiProperty({ required: false, nullable: true })
  deletedAt?: Date | null;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}
