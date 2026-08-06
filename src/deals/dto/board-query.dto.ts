import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';

/** Filters both board endpoints share, so a column can never disagree with its header. */
class BoardFilterDto {
  @ApiPropertyOptional({
    description: 'Defaults to the tenant default pipeline',
  })
  @IsMongoId()
  @IsOptional()
  pipelineId?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @Length(0, 200)
  search?: string;

  @ApiPropertyOptional({ description: 'Restrict the board to one owner' })
  @IsMongoId()
  @IsOptional()
  ownerId?: string;

  @ApiPropertyOptional({ enum: ['overdue', 'today', 'none'] })
  @IsIn(['overdue', 'today', 'none'])
  @IsOptional()
  followUp?: string;

  /** JSON-encoded `[{id, value}]`, the same shape the list view sends. */
  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @Length(0, 4000)
  filters?: string;
}

export class BoardSummaryQueryDto extends BoardFilterDto {}

export class BoardColumnQueryDto extends BoardFilterDto {
  @ApiProperty()
  @IsMongoId()
  stageId: string;

  @ApiPropertyOptional({ description: 'Opaque cursor from the previous page' })
  @IsString()
  @IsOptional()
  @Length(0, 500)
  cursor?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 25 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  limit?: number;
}
