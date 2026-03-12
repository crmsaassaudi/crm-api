import { ApiProperty } from '@nestjs/swagger';

export class Channel {
  @ApiProperty()
  id: string;

  @ApiProperty()
  tenant: string;

  @ApiProperty({
    enum: [
      'Facebook',
      'Zalo',
      'WhatsApp',
      'LiveChat',
      'Instagram',
      'TikTok',
      'Shopee',
      'Email',
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

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}
