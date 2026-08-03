import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsDate,
  IsArray,
  IsObject,
  ValidateNested,
  IsMongoId,
  IsIn,
  IsBoolean,
  IsInt,
  Min,
  Max,
  MaxLength,
  ArrayMaxSize,
  ValidateIf,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TASK_PRIORITIES, TASK_RECURRENCE_RULES } from '../tasks.constants';

class RelatedToDto {
  @ApiProperty({ example: 'Contact' })
  @IsString()
  @IsNotEmpty()
  @IsIn(['Contact', 'Account', 'Deal', 'Ticket'])
  type: string;

  @ApiProperty({ example: '60d0fe4f5311236168a109cc' })
  // `@IsMongoId` rather than `@IsString`: the value is written into
  // `relatedTo._id` and later compared against real ObjectIds, so a non-id
  // string produced a link that could never match anything.
  @IsMongoId()
  id: string;

  @ApiProperty({ example: 'John Doe' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  name: string;
}

export class CreateTaskDto {
  @ApiProperty({ example: 'Follow up with new lead' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  title: string;

  @ApiPropertyOptional({ example: 'Call John Doe regarding his interest' })
  @IsString()
  @IsOptional()
  @MaxLength(20_000)
  description?: string;

  @ApiProperty({ example: '2026-03-15T10:00:00Z' })
  @IsDate()
  @Type(() => Date)
  dueDate: Date;

  // Every reference below is `@IsMongoId`, not `@IsString`. These values become
  // ObjectId paths, so a malformed one used to surface as a Mongoose CastError —
  // a 500 for what is plainly a bad request. Existence and tenant membership are
  // checked separately by TaskReferenceValidator; shape is all a DTO can know.
  @ApiPropertyOptional({ example: '60d0fe4f5311236168a109cf' })
  @IsMongoId()
  @IsOptional()
  statusId?: string;

  @ApiProperty({ example: 'HIGH', enum: TASK_PRIORITIES })
  @IsIn(TASK_PRIORITIES as unknown as string[])
  priority: string;

  @ApiPropertyOptional({ example: '60d0fe4f5311236168a109cd' })
  @IsMongoId()
  @IsOptional()
  categoryId?: string;

  @ApiPropertyOptional({ example: '60d0fe4f5311236168a109cc' })
  // Empty string is accepted and normalised to "no owner" by the service, which
  // is why this is not a bare @IsMongoId.
  @ValidateIf((_object, value) => value !== '' && value !== null)
  @IsMongoId()
  @IsOptional()
  ownerId?: string;

  @ApiPropertyOptional()
  @IsObject()
  @IsOptional()
  @ValidateNested()
  @Type(() => RelatedToDto)
  relatedTo?: RelatedToDto;

  @ApiPropertyOptional({ example: ['follow-up'] })
  @IsArray()
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  @ArrayMaxSize(50)
  @IsOptional()
  tags?: string[];

  @ApiPropertyOptional({ example: '2026-03-14T09:00:00Z' })
  @IsDate()
  @Type(() => Date)
  @IsOptional()
  reminderAt?: Date;

  @ApiPropertyOptional({ example: 'manual' })
  @IsMongoId()
  @IsOptional()
  sourceId?: string;

  @ApiPropertyOptional()
  @IsObject()
  @IsOptional()
  customFields?: Record<string, any>;

  // RECURRENCE
  //
  // Absent from this DTO until now, which — with the global ValidationPipe's
  // `whitelist` + `forbidNonWhitelisted` — meant sending any of these fields got
  // a 422. No other code path wrote them either, so `isRecurring` was false for
  // every task ever created and `RecurringTaskService` scanned every tenant once
  // an hour to find nothing. The scheduler existed; the way to reach it did not.

  @ApiPropertyOptional({ default: false })
  @IsBoolean()
  @IsOptional()
  isRecurring?: boolean;

  @ApiPropertyOptional({ enum: TASK_RECURRENCE_RULES, example: 'weekly' })
  @IsIn(TASK_RECURRENCE_RULES as unknown as string[])
  @IsOptional()
  recurrenceRule?: 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly';

  @ApiPropertyOptional({ example: 2, minimum: 1, maximum: 365 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  // Bounded so an interval of 1e9 cannot push `nextOccurrenceAt` past the range
  // date-fns can represent, which would park the template outside every future
  // scheduler sweep.
  @Max(365)
  @IsOptional()
  recurrenceInterval?: number;

  @ApiPropertyOptional({ example: '2027-01-01T00:00:00Z' })
  @IsDate()
  @Type(() => Date)
  @IsOptional()
  recurrenceEndsAt?: Date;
}
