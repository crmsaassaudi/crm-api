import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsMongoId,
  IsOptional,
  ValidateIf,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DEAL_BULK_MAX_IDS } from '../deals.constants';

/**
 * Ids a bulk mutation applies to. Bounded by DEAL_BULK_MAX_IDS for the same
 * reason as the task/bulk-tag equivalents: an unbounded id list turns a
 * single request into an unbounded write.
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
    description:
      'Required when stageId moves a deal out of a closed stage or reclassifies Won ↔ Lost.',
  })
  @IsOptional()
  allowReopen?: boolean;
}

export interface BulkDealResult {
  /** Deals the caller could see AND that passed validation. */
  updated: number;
  /**
   * Ids that were skipped, with the reason. Reported rather than swallowed —
   * see BulkTaskResult for why a bulk endpoint that reports a bare "done" is
   * how bulk actions lose users' trust.
   */
  skipped: Array<{ id: string; reason: string }>;
}
