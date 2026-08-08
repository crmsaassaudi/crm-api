import { ApiProperty } from '@nestjs/swagger';
import { TemplateChannel } from './template-variant';

export const TEMPLATE_USAGE_CONTEXTS = [
  'agent',
  'campaign',
  'automation',
  'bot',
] as const;
export type TemplateUsageContext = (typeof TEMPLATE_USAGE_CONTEXTS)[number];

export class TemplateUsage {
  @ApiProperty()
  id: string;

  @ApiProperty()
  tenantId: string;

  @ApiProperty()
  templateId: string;

  @ApiProperty({ required: false })
  variantId?: string;

  @ApiProperty()
  channel: TemplateChannel;

  @ApiProperty({ enum: TEMPLATE_USAGE_CONTEXTS })
  context: TemplateUsageContext;

  @ApiProperty({ required: false })
  contextId?: string;

  @ApiProperty({ required: false })
  actorId?: string;

  /** Number of recipients this single usage row represents (campaign blasts count as one row). */
  @ApiProperty()
  count: number;

  @ApiProperty()
  sentAt: Date;
}
