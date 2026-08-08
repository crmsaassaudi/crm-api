import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsIn, IsString, Length } from 'class-validator';
import { IsOptional } from 'class-validator';
import {
  FILTER_OPERATORS,
  FilterCondition,
  FilterGroup,
} from '../contact-filter';

/**
 * The wire shape of a contact condition tree.
 *
 * Lives next to the compiler rather than inside one feature's DTO file, because
 * three features now send one: saved segments, campaign audiences, and the
 * unsaved preview both of them use.
 */

/**
 * One leaf condition.
 *
 * Only shape is validated here — that a field is filterable and that the
 * operator suits its type is decided by the compiler, which is the single place
 * that knows. Duplicating the rule in a DTO is how the two drift.
 */
export class FilterConditionDto implements FilterCondition {
  @ApiProperty({ example: 'lastPurchaseAt' })
  @IsString()
  @Length(1, 120)
  field: string;

  @ApiProperty({ enum: FILTER_OPERATORS as unknown as string[] })
  @IsIn(FILTER_OPERATORS as unknown as string[])
  operator: FilterCondition['operator'];

  @ApiPropertyOptional()
  @IsOptional()
  value?: unknown;
}

export class FilterGroupDto implements FilterGroup {
  @ApiProperty({ enum: ['all', 'any'] })
  @IsIn(['all', 'any'])
  match: 'all' | 'any';

  /**
   * Conditions, or nested groups.
   *
   * `@ValidateNested` cannot discriminate the union, so nesting is validated by
   * the compiler on save (the preview endpoint runs the same compile). Depth and
   * breadth ARE bounded here: an unbounded tree is a request-shaped way to build
   * a query the planner cannot execute.
   */
  @ApiProperty({ type: [FilterConditionDto] })
  @IsArray()
  @ArrayMaxSize(50)
  conditions: Array<FilterCondition | FilterGroup>;
}
