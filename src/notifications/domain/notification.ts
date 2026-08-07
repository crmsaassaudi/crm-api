import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { NotificationType } from '../infrastructure/persistence/document/entities/notification.schema';

export class Notification {
  @ApiProperty()
  id: string;

  @ApiProperty()
  type: NotificationType;

  @ApiProperty()
  title: string;

  @ApiPropertyOptional()
  body?: string;

  @ApiPropertyOptional()
  link?: { type: string; id: string } | null;

  @ApiPropertyOptional()
  readAt?: Date | null;

  @ApiProperty()
  createdAt: Date;
}
