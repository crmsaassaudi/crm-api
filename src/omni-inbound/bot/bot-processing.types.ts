import { ChannelType } from '../domain/omni-payload';

export interface BotProcessingJobData {
  tenantId: string;
  org: string;
  conversationId: string;
  messageId: string;
  text: string;
  channel: ChannelType;
}

export interface BotReplyRequest {
  org: string;
  conversationId: string;
  flowId: string;
  inboundMessageId: string;
  text: string;
  channel: ChannelType;
  sessionId?: string | null;
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

export interface BotReplyResponse {
  ok?: boolean;
  duplicate?: boolean;
  sessionId?: string;
  status?: 'active' | 'handoff' | 'ended';
  handoff?: boolean;
  messages?: BotReplyMessage[];
}
