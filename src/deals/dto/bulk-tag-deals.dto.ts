import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsMongoId,
  IsString,
  Length,
} from 'class-validator';
import { DEAL_MAX_BULK_TAG_SIZE } from '../deals.constants';

/**
 * Bulk tagging used to take an untyped `{ dealIds, tags }` literal, so the global
 * validation pipe had nothing to check: any shape reached the service and the
 * only bound on the id list was the one the service re-implemented by hand.
 */
export class BulkTagDealsDto {
  @ApiProperty({ type: [String], maxItems: DEAL_MAX_BULK_TAG_SIZE })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(DEAL_MAX_BULK_TAG_SIZE)
  @IsMongoId({ each: true })
  dealIds: string[];

  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @Length(1, 60, { each: true })
  tags: string[];
}
