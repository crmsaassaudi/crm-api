export type ChannelType = 'facebook' | 'instagram' | 'zalo' | 'whatsapp' | 'livechat';
export type SenderType = 'customer' | 'agent' | 'system';
export type MessageType =
  | 'text'
  | 'image'
  | 'file'
  | 'audio'
  | 'video'
  | 'location'
  | 'sticker'
  | 'template';

/**
 * Standard normalized payload — the single shape that flows through the
 * entire omni pipeline regardless of which provider originated the data.
 */
export interface OmniPayload {
  /** Internal tenant identifier (from CLS / JWT) */
  tenantId: string;

  /** Reference to the Channel document in our DB */
  channelId: string;

  /** Stable provider identifier (e.g. Page ID, OA ID) */
  channelAccount: string;

  /** Provider type enum */
  channelType: ChannelType;

  /** External user ID from the provider (e.g. FB psid, Zalo uid) */
  senderId: string;

  /** Who sent this message */
  senderType: SenderType;

  /** Semantic message type */
  messageType: MessageType;

  /** Text body (empty string for media-only messages) */
  content: string;

  /** Original media URL from the provider (may expire for Zalo) */
  mediaUrl?: string;

  /** Our proxied / cached media URL (stable, never expires) */
  mediaProxyUrl?: string;

  /** Freeform provider-specific extras (reactions, quick_replies, etc.) */
  metadata: Record<string, any>;

  /** Provider's message ID */
  externalMessageId: string;

  /** Provider's conversation / thread ID */
  externalConversationId: string;

  /** When the message was created at the provider */
  timestamp: Date;
}

/**
 * Persisted message entity — extends OmniPayload with our internal IDs
 * and delivery-status tracking for optimistic UI.
 */
export interface OmniMessage extends OmniPayload {
  /** Internal Mongo ObjectId */
  id: string;

  /** Conversation ID in our system (not the external one) */
  conversationId: string;

  /** Delivery status for optimistic send */
  status: 'sending' | 'sent' | 'delivered' | 'read' | 'failed';
}
