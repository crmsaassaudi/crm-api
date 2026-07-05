import { PartialType, ApiPropertyOptional } from '@nestjs/swagger';
import { CreateTaskDto } from './create-task.dto';
import { IsDate, IsOptional } from 'class-validator';
import { Type } from 'class-transformer';

export class UpdateTaskDto extends PartialType(CreateTaskDto) {
  @ApiPropertyOptional({ example: '2026-03-16T12:00:00Z' })
  @IsDate()
  @Type(() => Date)
  @IsOptional()
  completedAt?: Date;
}
