export class TimelineQueryDto {
  sessionLimit?: string;
  messageLimit?: string;

  pastCursorCreatedAt?: string;
  pastCursorId?: string;

  futureCursorCreatedAt?: string;
  futureCursorId?: string;
}
