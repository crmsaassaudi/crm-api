import { ApiProperty } from '@nestjs/swagger';

export const TEMPLATE_CHANNELS = ['generic', 'email', 'sms', 'whatsapp'] as const;
export type TemplateChannel = (typeof TEMPLATE_CHANNELS)[number];

export const TEMPLATE_CONTENT_TYPES = ['text', 'interactive', 'carousel'] as const;
export type TemplateContentType = (typeof TEMPLATE_CONTENT_TYPES)[number];

export const WHATSAPP_TEMPLATE_CATEGORIES = [
  'UTILITY',
  'MARKETING',
  'AUTHENTICATION',
] as const;
export type WhatsAppTemplateCategory = (typeof WHATSAPP_TEMPLATE_CATEGORIES)[number];

export const WHATSAPP_TEMPLATE_STATUSES = [
  'PENDING',
  'APPROVED',
  'REJECTED',
  'PAUSED',
  'DELETED',
] as const;
export type WhatsAppTemplateApprovalStatus =
  (typeof WHATSAPP_TEMPLATE_STATUSES)[number];

export interface TemplateButton {
  id: string;
  title: string;
}

export interface TemplateCard {
  title: string;
  subtitle?: string;
  imageUrl?: string;
  buttons?: TemplateButton[];
}

export interface WhatsAppProviderBinding {
  provider: 'meta_whatsapp';
  externalId?: string;
  category?: WhatsAppTemplateCategory;
  approvalStatus?: WhatsAppTemplateApprovalStatus;
  rejectionReason?: string;
  components?: any[];
  syncedAt?: Date;
}

export class TemplateVariant {
  @ApiProperty()
  id: string;

  @ApiProperty()
  tenantId: string;

  @ApiProperty()
  templateId: string;

  @ApiProperty({ enum: TEMPLATE_CHANNELS })
  channel: TemplateChannel;

  @ApiProperty({ example: 'vi' })
  locale: string;

  @ApiProperty({ enum: TEMPLATE_CONTENT_TYPES })
  contentType: TemplateContentType;

  @ApiProperty({ required: false })
  subject?: string;

  @ApiProperty({ required: false })
  body?: string;

  @ApiProperty({ required: false })
  htmlContent?: string;

  @ApiProperty({ required: false })
  designJson?: string;

  @ApiProperty({ required: false, type: [Object] })
  buttons?: TemplateButton[];

  @ApiProperty({ required: false, type: [Object] })
  cards?: TemplateCard[];

  @ApiProperty({ required: false, type: [String] })
  attachments?: string[];

  @ApiProperty({ required: false })
  providerBinding?: WhatsAppProviderBinding;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}
