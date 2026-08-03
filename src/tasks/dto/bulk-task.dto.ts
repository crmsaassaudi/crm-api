import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsMongoId,
  IsOptional,
  ValidateIf,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TASK_BULK_MAX_IDS, TASK_PRIORITIES } from '../tasks.constants';

/**
 * Ids a bulk mutation applies to.
 *
 * Bounded by `TASK_BULK_MAX_IDS`. A tenant with 10.000 users needs to triage in
 * bulk — the alternative was one HTTP request per row, which is how a UI ends up
 * generating its own load problem — but an unbounded id list would turn a single
 * request into an unbounded write.
 */
export class BulkTaskIdsDto {
  @ApiProperty({ type: [String], maxItems: TASK_BULK_MAX_IDS })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(TASK_BULK_MAX_IDS)
  @IsMongoId({ each: true })
  ids: string[];
}

export class BulkUpdateTasksDto extends BulkTaskIdsDto {
  @ApiPropertyOptional({ description: 'New status for every selected task' })
  @IsMongoId()
  @IsOptional()
  statusId?: string;

  @ApiPropertyOptional({ enum: TASK_PRIORITIES })
  @IsIn(TASK_PRIORITIES as unknown as string[])
  @IsOptional()
  priority?: string;

  @ApiPropertyOptional({ description: 'Reassign every selected task' })
  // Empty string clears the owner, same convention as the single-task DTO.
  @ValidateIf((_object, value) => value !== '' && value !== null)
  @IsMongoId()
  @IsOptional()
  ownerId?: string;

  @ApiPropertyOptional({ description: 'New category' })
  @IsMongoId()
  @IsOptional()
  categoryId?: string;
}

export interface BulkTaskResult {
  /** Tasks the caller could see AND that passed validation. */
  updated: number;
  /**
   * Ids that were skipped, with the reason.
   *
   * Reported rather than swallowed: a bulk operation that says "200 OK" while
   * quietly dropping half the selection is the reason bulk endpoints get
   * distrusted. The common causes are a scope miss (not the caller's row) and a
   * lifecycle refusal (the task is complete and this would reschedule it).
   */
  skipped: Array<{ id: string; reason: string }>;
}
