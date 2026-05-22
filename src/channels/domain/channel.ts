import { ApiProperty } from '@nestjs/swagger';

export class Channel {
  @ApiProperty()
  id: string;

  @ApiProperty()
  tenantId: string;

  @ApiProperty({
    enum: [
      'facebook',
      'zalo',
      'whatsapp',
      'livechat',
      'instagram',
      'tiktok',
      'shopee',
      'email',
    ],
  })
  type: string;

  @ApiProperty({ example: 'Facebook Page A' })
  name: string;

  @ApiProperty({ example: 'page_a' })
  account: string;

  @ApiProperty({ enum: ['Connected', 'Disconnected', 'Error', 'Pending'] })
  status: string;

  @ApiProperty()
  config: Record<string, any>;

  credentials?: Record<string, any>;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}
