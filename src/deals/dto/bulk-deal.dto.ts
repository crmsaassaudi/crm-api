import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDate,
  IsMongoId,
  IsOptional,
  ValidateIf,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DEAL_BULK_MAX_IDS } from '../deals.constants';

/**
 * Ids a bulk mutation applies to. Bounded by DEAL_BULK_MAX_IDS for the same
 * reason as the task/bulk-tag equivalents: an unbounded id list turns a single
 * request into an unbounded write.
 */
export class BulkDealIdsDto {
  @ApiProperty({ type: [String], maxItems: DEAL_BULK_MAX_IDS })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(DEAL_BULK_MAX_IDS)
  @IsMongoId({ each: true })
  ids: string[];
}

export class BulkUpdateDealsDto extends BulkDealIdsDto {
  @ApiPropertyOptional({ description: 'New stage for every selected deal' })
  @IsMongoId()
  @IsOptional()
  stageId?: string;

  @ApiPropertyOptional({ description: 'Reassign every selected deal' })
  @ValidateIf((_object, value) => value !== '' && value !== null)
  @IsMongoId()
  @IsOptional()
  ownerId?: string;

  @ApiPropertyOptional({
    description: 'Set the next follow-up on every selected deal',
  })
  @IsDate()
  @Type(() => Date)
  @IsOptional()
  nextFollowUpAt?: Date | null;

  /**
   * `@IsBoolean()` is load-bearing: untyped, the string `"false"` arrives truthy
   * and waves 500 closed deals through the reopen guard in one request.
   */
  @ApiPropertyOptional({
    description:
      'Required when stageId moves a deal out of a closed stage or reclassifies Won ⇄ Lost.',
  })
  @IsBoolean()
  @IsOptional()
  allowReopen?: boolean;
}

export interface BulkDealResult {
  /** Deals the caller could see AND that passed validation. */
  updated: number;
  /**
   * Ids that were skipped, with the reason. Reported rather than swallowed — a
   * bulk endpoint that answers a bare "done" over a partial result is how bulk
   * actions lose users' trust.
   */
  skipped: Array<{ id: string; reason: string }>;
}
