import { ApiProperty } from '@nestjs/swagger';

/** Serving mode — see ChannelSchemaClass.support for the semantics. */
export type ChannelSupportMode = 'restricted' | 'open';

export class ChannelSupport {
  @ApiProperty({ type: [String] })
  userIds: string[];

  @ApiProperty({ type: [String] })
  groupIds: string[];

  @ApiProperty({ enum: ['restricted', 'open'] })
  mode: ChannelSupportMode;
}

/** Shape stored when a channel has never had its support pool configured. */
export const DEFAULT_CHANNEL_SUPPORT: ChannelSupport = {
  userIds: [],
  groupIds: [],
  mode: 'open',
};

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

  @ApiProperty({
    description:
      'Who may serve this channel. mode=restricted makes the lists an ' +
      'authorization boundary; mode=open makes them a routing preference only.',
  })
  support: ChannelSupport;

  credentials?: Record<string, any>;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}
