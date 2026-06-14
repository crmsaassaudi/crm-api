import { ChannelType } from '../domain/omni-payload';

export interface BotProcessingJobData {
  tenantId: string;
  org: string;
  channelId: string;
  conversationId: string;
  messageId: string;
  text: string;
  channel: ChannelType;
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
  type: 'text';
  text: string;
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
}
