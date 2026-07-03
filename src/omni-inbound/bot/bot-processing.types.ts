import { ChannelType } from '../domain/omni-payload';

export interface BotProcessingJobData {
  tenantId: string;
  org: string;
  channelId: string;
  conversationId: string;
  messageId: string;
  text: string;
  channel: ChannelType;
  /** Button/interactive reply ID — for exact bot branch matching */
  replyId?: string;
  /** Original message type (text, image, video, etc.) */
  messageType?: string;
  /** Customer message providerTimestamp — bot replies must sort after this */
  inboundProviderTimestamp?: string;
}

export interface BotReplyRequest {
  org: string;
  /** CRM Channel document _id — bot resolves flow per channel */
  channelId: string;
  conversationId: string;
  inboundMessageId: string;
  text: string;
  channel: ChannelType;
  sessionId?: string | null;
  /** CRM-API callback URL for bot to POST results */
  callbackUrl: string;
  /** Button reply ID — Typebot item.id for exact branch matching */
  replyId?: string;
  /** Original message type (text, image, video, etc.) */
  messageType?: string;
}

/** Immediate response from bot — just acceptance */
export interface BotAcceptResponse {
  accepted: boolean;
  duplicate?: boolean;
  error?: string;
}

export interface BotReplyButton {
  id?: string;
  label: string;
  value?: string;
}

export interface BotReplyMessage {
  type: 'text' | 'image' | 'video' | 'audio' | 'file';
  /** Text content (for type=text) or caption (for media types) */
  text?: string;
  /** Media URL (for image/video/audio/file types) */
  url?: string;
  /** MIME type of the media (e.g., "image/png", "video/mp4") */
  mimeType?: string;
  buttons?: BotReplyButton[];
  raw?: unknown;
}

/** Callback payload received from bot after async processing */
export interface BotCallbackPayload {
  org: string;
  conversationId: string;
  inboundMessageId: string;
  sessionId?: string;
  status: 'active' | 'handoff' | 'ended';
  handoff: boolean;
  messages: BotReplyMessage[];
  handoffMeta?: {
    target: 'general' | 'group' | 'agent';
    groupId?: string;
    agentId?: string;
    message?: string;
  };
}
