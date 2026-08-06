import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  MaxLength,
  Max,
  Min,
  MinLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Longest body accepted, matching the ticket description cap. */
export const TICKET_MESSAGE_MAX_BODY = 50_000;

export class CreateTicketMessageDto {
  @ApiProperty({
    enum: ['reply', 'note'],
    description:
      '`reply` is visible to the customer and satisfies first response; `note` is internal.',
  })
  @IsIn(['reply', 'note'])
  kind: 'reply' | 'note';

  @ApiProperty({ example: 'We have refunded the duplicate charge.' })
  @IsString()
  @MinLength(1)
  @MaxLength(TICKET_MESSAGE_MAX_BODY)
  body: string;

  @ApiPropertyOptional({ description: 'Ids of files already uploaded' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsMongoId({ each: true })
  attachmentIds?: string[];
}

export class UpdateTicketMessageDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(TICKET_MESSAGE_MAX_BODY)
  body: string;
}

export class TicketTimelineQueryDto {
  /**
   * Cursor pagination, not page/limit: a busy ticket's timeline is append-only
   * and read newest-page-first, and `skip` would re-scan the whole thread every
   * time an agent loads more.
   */
  @ApiPropertyOptional({ description: 'Return entries older than this id' })
  @IsOptional()
  @IsMongoId()
  before?: string;

  @ApiPropertyOptional({ default: 30, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({
    enum: ['all', 'conversation'],
    description:
      '`conversation` drops system entries — the customer-facing thread only.',
  })
  @IsOptional()
  @IsIn(['all', 'conversation'])
  view?: 'all' | 'conversation';
}
