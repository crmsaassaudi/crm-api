import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class ListConversationsQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  limit?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  channels?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  assignedTo?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  sla?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  tags?: string;

  @ApiPropertyOptional({ enum: ['any', 'all'] })
  @IsOptional()
  @IsString()
  tagsMatchMode?: 'any' | 'all';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  isVip?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  hasUnread?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  contactId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  page?: string;

  @ApiPropertyOptional({ description: 'ISO date — lower bound (inclusive)' })
  @IsOptional()
  @IsString()
  dateFrom?: string;

  @ApiPropertyOptional({ description: 'ISO date — upper bound (inclusive)' })
  @IsOptional()
  @IsString()
  dateTo?: string;

  @ApiPropertyOptional({
    description: 'Which timestamp dateFrom/dateTo filter against',
    enum: ['createdAt', 'updatedAt'],
  })
  @IsOptional()
  @IsString()
  dateField?: 'createdAt' | 'updatedAt';

  @ApiPropertyOptional({
    description:
      'Filters conversations whose last message is still from the customer ' +
      '(i.e. the agent has not replied yet). "longestWaiting" sorts oldest-first ' +
      'instead of the default newest-first; "readNotReplied" additionally requires unreadCount=0.',
    enum: ['recent', 'longestWaiting', 'readNotReplied'],
  })
  @IsOptional()
  @IsString()
  unansweredMode?: 'recent' | 'longestWaiting' | 'readNotReplied';
}
