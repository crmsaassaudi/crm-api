import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import {
  WORKFLOW_STATUSES,
  WorkflowStatus,
} from '../infrastructure/persistence/document/entities/automation-workflow.schema';

/**
 * Query for `GET /automation/workflows`.
 *
 * A DTO rather than two loose `@Query()` strings: the global pipe runs with
 * `whitelist` and `forbidNonWhitelisted`, so both values are validated and
 * anything else is rejected. A bare `@Query('status')` typed as a string union
 * erases to `String` at runtime, which the pipe does not validate — and Express
 * parses `?status[$ne]=draft` into an object, so the value reaching the filter
 * would have been a Mongo operator.
 */
export class ListWorkflowsQueryDto {
  @IsOptional()
  @IsIn(WORKFLOW_STATUSES)
  status?: WorkflowStatus;

  /**
   * Free-text over name and description. Bounded because it becomes a regex;
   * `escapeRegex` in the repository handles the metacharacters.
   */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;
}
