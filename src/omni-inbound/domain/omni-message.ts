export type SenderType = 'customer' | 'agent' | 'system';
export type MessageType = 'text' | 'image' | 'file' | 'audio' | 'video' | 'location' | 'sticker' | 'template';
export type MessageStatus = 'sending' | 'sent' | 'delivered' | 'read' | 'failed';

export interface OmniMessage {
  id: string;
  tenantId: string;
  conversationId: string;
  senderId: string;
  senderType: SenderType;
  messageType: MessageType;
  content: string;
  mediaUrl?: string;
  mediaProxyUrl?: string;
  status: MessageStatus;
  metadata?: Record<string, any>;
  externalMessageId?: string;
  createdAt: Date;
  updatedAt: Date;
}
