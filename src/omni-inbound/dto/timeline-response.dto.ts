import { SessionBlockDto } from './session-block.dto';

export interface TimelineResponseDto {
  pastSessions: SessionBlockDto[];
  anchorSession: SessionBlockDto;
  futureSessions: SessionBlockDto[];
  hasMorePast: boolean;
  hasMoreFuture: boolean;
  pastCursor: {
    createdAt: Date;
    id: string;
  } | null;
  futureCursor: {
    createdAt: Date;
    id: string;
  } | null;
}
