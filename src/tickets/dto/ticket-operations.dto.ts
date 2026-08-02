import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { TICKET_MAX_BULK_TAG_SIZE } from '../tickets.constants';

export class BulkTagTicketsDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(TICKET_MAX_BULK_TAG_SIZE)
  @IsMongoId({ each: true })
  ticketIds: string[];

  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(100)
  @IsMongoId({ each: true })
  tags: string[];
}

export class MergeTicketDto {
  @IsMongoId()
  sourceId: string;
}

export class LinkTicketDealDto {
  @IsMongoId()
  dealId: string;
}

export class SetTicketParentDto {
  @IsMongoId()
  parentTicketId: string;
}

export class TicketListQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @IsOptional()
  @IsMongoId()
  statusId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2_000)
  statusIds?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  priority?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2_000)
  priorities?: string;

  @IsOptional()
  @IsMongoId()
  typeId?: string;

  @IsOptional()
  @IsMongoId()
  groupId?: string;

  @IsOptional()
  @IsMongoId()
  contactId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10_000)
  filters?: string;
}

export class PageQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 25;
}

export class JobListQueryDto extends PageQueryDto {
  @IsOptional()
  @IsIn(['queued', 'active', 'completed', 'failed', 'delayed', 'waiting'])
  status?: string;
}
