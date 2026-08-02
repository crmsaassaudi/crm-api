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
 * What a channel created today starts as: open, with the creator recorded.
 *
 * It used to start `restricted` with a pool of one. That reads as the safe
 * choice and is not: `servableChannelIds` is `null` (unrestricted) only while a
 * tenant has NO channels, so the moment an admin connected the first one, every
 * other agent's conversation query became `channelId: { $in: [] }` and the omni
 * inbox went blank workspace-wide. Fail-closed on an axis whose empty state
 * means "see nothing" is not a safe default, it is an outage with a good
 * reason.
 *
 * Narrowing stays one edit away in Settings → Channels, and the pool is seeded
 * with the creator so switching to `restricted` never leaves it empty.
 */
export function newChannelSupport(
  creatorUserId?: string | null,
): ChannelSupport {
  return {
    userIds: creatorUserId ? [String(creatorUserId)] : [],
    groupIds: [],
    excludedUserIds: [],
    mode: 'open',
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

  @ApiProperty({ required: false, nullable: true })
  inboxId: string | null;

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
