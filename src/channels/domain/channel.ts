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

/** Per-channel override of the tenant `data_visibility.defaultAccess` setting. */
export type ChannelVisibility = 'inherit' | 'private' | 'public_read';

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

  @ApiProperty({
    enum: ['inherit', 'private', 'public_read'],
    description:
      'Per-channel override of the tenant-wide data_visibility default. ' +
      "'inherit' defers to the tenant setting; 'private'/'public_read' force " +
      'the owner-scope behaviour for this channel regardless of it.',
  })
  visibility: ChannelVisibility;

  credentials?: Record<string, any>;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}
