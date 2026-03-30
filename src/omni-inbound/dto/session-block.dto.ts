import { SessionMessageSliceDto } from './session-message-slice.dto';

export interface SessionBlockDto {
  id: string;
  status: string;
  createdAt: Date;
  resolvedAt: Date | null;
  resolvedByAgentId: string | null;
  resolvedByAgentName: string | null;
  resolvedByAgentEmail: string | null;
  resolveReason: string | null;
  resolveNote: string | null;
  resolveSource: string | null;
  lastMessage: string;
  messages: SessionMessageSliceDto;
}
