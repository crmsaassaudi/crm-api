export interface SessionMessageSliceDto {
  data: Array<{
    id: string;
    conversationId: string;
    senderId: string;
    senderType: string;
    messageType: string;
    content: string;
    mediaUrl?: string;
    mediaProxyUrl?: string;
    status: string;
    metadata?: Record<string, any>;
    externalMessageId?: string;
    createdAt: Date;
    updatedAt: Date;
  }>;
  hasMore: boolean;
  cursor: {
    createdAt: Date;
    id: string;
  } | null;
}
