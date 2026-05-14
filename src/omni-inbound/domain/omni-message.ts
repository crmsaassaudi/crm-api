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
export type MessageStatus =
  | 'sending'
  | 'sent'
  | 'delivered'
  | 'read'
  | 'failed';

export interface OmniMessage {
  id: string;
  tenantId: string;
  conversationId: string;
  senderId: string;
  senderName?: string | null;
  senderAvatarUrl?: string | null;
  senderType: SenderType;
  source?: string | null;
  messageType: MessageType;
  content: string;
  mediaUrl?: string;
  mediaProxyUrl?: string;
  status: MessageStatus;
  metadata?: Record<string, any>;
  externalMessageId?: string;
  idempotencyKey?: string;
  clientMessageId?: string;
  providerTimestamp?: Date;
  createdAt: Date;
  updatedAt: Date;
}
