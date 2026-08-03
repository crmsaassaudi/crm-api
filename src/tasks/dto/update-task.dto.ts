import { PartialType, ApiPropertyOptional } from '@nestjs/swagger';
import { CreateTaskDto } from './create-task.dto';
import { IsDate, IsInt, IsOptional, Min, IsMongoId } from 'class-validator';
import { Type } from 'class-transformer';

export class UpdateTaskDto extends PartialType(CreateTaskDto) {
  @ApiPropertyOptional({ example: '2026-03-16T12:00:00Z' })
  @IsDate()
  @Type(() => Date)
  @IsOptional()
  completedAt?: Date;

  /**
   * Move the task to a different node of the org tree.
   *
   * Accepted here because the mapper can now persist it. While the mapper
   * omitted `orgUnitId`, the field was stamped once at create time from the
   * creator's unit and was then unchangeable — so a task could not follow a
   * reorganisation, and the org-unit data scope kept showing it to the old unit.
   */
  @ApiPropertyOptional({ description: 'Org unit that owns this task' })
  @IsMongoId()
  @IsOptional()
  orgUnitId?: string;

  /**
   * The revision the client last read.
   *
   * Optional on purpose. Supplied, it is a true optimistic lock: the write only
   * lands if nobody else has changed the task since, otherwise the caller gets
   * `409` and can reload. Omitted, the service falls back to the revision it
   * reads immediately before writing, which is the older and much weaker
   * guarantee — so existing clients keep working and clients that send it get
   * protected against the lost update that concurrent form edits produce.
   */
  @ApiPropertyOptional({ description: 'Revision read by the client (__v)' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @IsOptional()
  version?: number;
}
