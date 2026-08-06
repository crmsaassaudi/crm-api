import {
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  TASK_LIST_DEFAULT_LIMIT,
  TASK_LIST_MAX_LIMIT,
  TASK_PRIORITIES,
} from '../tasks.constants';
import { CustomFieldDefinitions } from '../../utils/custom-field-filter';
import { SORTABLE_FIELDS } from '../../object-manager/sortable-fields';

/**
 * Turn `?statusIds=a,b` and `?statusIds[]=a&statusIds[]=b` into one shape.
 *
 * The web client joins multi-selects with commas, so a plain `@IsArray()` would
 * reject the request the UI actually sends.
 */
const toStringArray = ({ value }: { value: unknown }): string[] | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  const parts = Array.isArray(value) ? value : String(value).split(',');
  return parts.map((part) => String(part).trim()).filter(Boolean);
};

/**
 * Validated query for `GET /v1/tasks`.
 *
 * This class is the whole point of the fix, not decoration: the handler used to
 * declare `@Query() query: any`, and the global `ValidationPipe` — which runs
 * with `whitelist: true` and `forbidNonWhitelisted: true` — has nothing to
 * enforce without a DTO class to enforce it against. So every guarantee those
 * two options provide elsewhere in the codebase was absent on this one route,
 * including any upper bound on `limit`.
 */
export class TaskListQueryDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({
    default: TASK_LIST_DEFAULT_LIMIT,
    maximum: TASK_LIST_MAX_LIMIT,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(TASK_LIST_MAX_LIMIT)
  limit?: number;

  @ApiPropertyOptional({ description: 'Free-text match on title/description' })
  @IsOptional()
  @IsString()
  // Capped because the value becomes a regex against title and description. The
  // pattern is escaped (so this is not a ReDoS vector) but an unbounded literal
  // is still an unbounded literal for Mongo to compare against every document.
  @MaxLength(200)
  search?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @Transform(toStringArray)
  @IsArray()
  @IsMongoId({ each: true })
  statusIds?: string[];

  /** Comma-separated status apiNames, resolved to ids by the repository. */
  @ApiPropertyOptional({ example: 'pending,in_progress' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  status?: string;

  @ApiPropertyOptional({ enum: TASK_PRIORITIES, isArray: true })
  @IsOptional()
  @Transform(({ value }) =>
    toStringArray({ value })?.map((v) => v.toUpperCase()),
  )
  @IsArray()
  @IsIn(TASK_PRIORITIES as unknown as string[], { each: true })
  priorities?: string[];

  @ApiPropertyOptional({ enum: TASK_PRIORITIES })
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.toUpperCase() : value,
  )
  @IsIn(TASK_PRIORITIES as unknown as string[])
  priority?: string;

  @ApiPropertyOptional({ example: '2026-09-01T00:00:00Z' })
  @IsOptional()
  @IsDateString()
  dueFrom?: string;

  @ApiPropertyOptional({ example: '2026-09-30T23:59:59Z' })
  @IsOptional()
  @IsDateString()
  dueTo?: string;

  @ApiPropertyOptional({ description: 'Tasks linked to this contact' })
  @IsOptional()
  @IsMongoId()
  contactId?: string;

  @ApiPropertyOptional({ description: 'Owner ids (comma-separated)' })
  @IsOptional()
  @Transform(toStringArray)
  @IsArray()
  @IsMongoId({ each: true })
  ownerIds?: string[];

  /**
   * TanStack-table filter descriptors, sent as a JSON string.
   *
   * Kept as an opaque string here and parsed in the repository, which already
   * has to tolerate malformed JSON from saved views. Validating the inner shape
   * would duplicate the custom-field filter contract that
   * `applyRegisteredCustomFieldFilters` owns.
   */
  @ApiPropertyOptional({ description: 'JSON-encoded filter descriptors' })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  filters?: string;

  /**
   * Only fields with a compound index behind them.
   *
   * `updatedAt` and `title` are deliberately absent: offering a sort the database
   * cannot serve from an index is how a list view starts sorting in memory, and
   * past Mongo's 32MB sort limit that is an outright query failure rather than
   * slowness. Adding one means adding its index in `task.schema.ts` first.
   */
  @ApiPropertyOptional({ enum: SORTABLE_FIELDS.Task })
  @IsOptional()
  @IsIn(SORTABLE_FIELDS.Task)
  sortBy?: string;

  @ApiPropertyOptional({ enum: ['asc', 'desc'] })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortOrder?: 'asc' | 'desc';
}

/**
 * What the repository consumes. Wider than the DTO because two callers add
 * fields the HTTP surface does not expose: `ContactsController` injects
 * `contactId`, and the service injects resolved custom-field definitions.
 */
export interface TaskListFilter
  extends Omit<TaskListQueryDto, 'filters' | 'priorities'> {
  filters?: string | Array<{ id: string; value: unknown }>;
  priorities?: string[];
  __customFieldDefinitions?: CustomFieldDefinitions;
}
