import { ApiProperty } from '@nestjs/swagger';

/** Serving mode — see ChannelSchemaClass.support for the semantics. */
export type ChannelSupportMode = 'restricted' | 'open';

export class ChannelSupport {
  @ApiProperty({ type: [String] })
  userIds: string[];

  @ApiProperty({ type: [String] })
  groupIds: string[];

  /**
   * Members excluded from the pool even though a selected group contains them.
   *
   * Groups express policy ("the support team serves this channel"); this list
   * expresses the exception ("except this trainee"). Without it the only way to
   * keep one person out was to stop using the group and enumerate its members,
   * which then stops tracking the group as people join and leave it.
   *
   * Deny beats allow: subtracted AFTER the union of direct ids and group
   * members, so it also overrides a direct `userIds` entry.
   */
  @ApiProperty({ type: [String] })
  excludedUserIds: string[];

  @ApiProperty({ enum: ['restricted', 'open'] })
  mode: ChannelSupportMode;
}

/** Shape stored when a channel has never had its support pool configured. */
export const DEFAULT_CHANNEL_SUPPORT: ChannelSupport = {
  userIds: [],
  groupIds: [],
  excludedUserIds: [],
  mode: 'open',
};

/**
 * What a channel created today starts as.
 *
 * Deliberately different from DEFAULT_CHANNEL_SUPPORT, which is also the
 * fallback for documents written before `support` existed — flipping that one
 * to 'restricted' would retroactively lock every legacy channel to an empty
 * pool, i.e. to nobody. New channels fail closed; old ones keep working.
 *
 * A new channel is seeded with its creator so "restricted" never means "dead
 * on arrival".
 */
export function newChannelSupport(
  creatorUserId?: string | null,
): ChannelSupport {
  return {
    userIds: creatorUserId ? [String(creatorUserId)] : [],
    groupIds: [],
    excludedUserIds: [],
    mode: 'restricted',
  };
}

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
