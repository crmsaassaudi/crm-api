import { ChannelType } from './omni-payload';

/**
 * Normalized reaction payload — the single shape that flows through the
 * entire omni pipeline regardless of which provider originated the reaction.
 *
 * Platform-specific adapters translate their raw webhook formats into this
 * unified structure so ReactionService can process all channels identically.
 *
 * Supported platforms:
 *   WhatsApp   — msg.type === 'reaction' → { reaction: { message_id, emoji } }
 *   Facebook   — rawPayload.reaction → { reaction, emoji, action, mid }
 *   Instagram  — rawPayload.reaction → same as Facebook
 *   Zalo       — event_name: 'oa_send_react' → { message: { msg_id, react_icon } }
 *   Livechat   — visitor:reaction socket event → { messageId, emoji }
 */
export interface OmniReactionPayload {
  tenantId: string;
  channelType: ChannelType;
  channelId: string;

  /** Our internal message ID (resolved from externalMessageId by ReactionService) */
  messageId?: string;

  /** Provider's message ID that was reacted to */
  externalMessageId: string;

  /** Who reacted */
  senderId: string;
  senderType: 'customer' | 'agent';

  /** Emoji character (e.g. '👍', '❤️') — universal across all platforms */
  emoji: string;

  /**
   * 'react' = add/update reaction
   * 'unreact' = remove reaction (WhatsApp sends empty emoji, Facebook sends action:'unreact')
   */
  action: 'react' | 'unreact';

  timestamp: Date;
}
