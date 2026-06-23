import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class RichMessageTemplate {
  @ApiProperty()
  id: string;

  @ApiProperty()
  tenantId: string;

  @ApiProperty({ example: 'Xác nhận đơn hàng' })
  name: string;

  @ApiPropertyOptional({ example: '/confirm' })
  shortcut: string;

  @ApiProperty({ enum: ['interactive', 'carousel'] })
  type: 'interactive' | 'carousel';

  @ApiProperty({ type: [String], example: ['whatsapp', 'livechat'] })
  channelTypes: string[];

  @ApiPropertyOptional({ example: 'Bạn muốn chọn option nào?' })
  body: string;

  @ApiPropertyOptional()
  buttons: Array<{ id: string; title: string }>;

  @ApiPropertyOptional()
  cards: Array<{
    title: string;
    subtitle?: string;
    imageUrl?: string;
    buttons?: Array<{ id: string; title: string }>;
  }>;

  @ApiProperty({ enum: ['Public', 'Private'] })
  scope: string;

  @ApiPropertyOptional()
  createdById: string;

  @ApiProperty()
  isActive: boolean;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}
