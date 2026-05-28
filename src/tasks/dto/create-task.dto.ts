import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsDate,
  IsArray,
  IsObject,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

class RelatedToDto {
  @ApiProperty({ example: 'Contact' })
  @IsString()
  @IsNotEmpty()
  type: string;

  @ApiProperty({ example: '60d0fe4f5311236168a109cc' })
  @IsString()
  @IsNotEmpty()
  id: string;

  @ApiPropertyOptional({ example: 'John Doe' })
  @IsString()
  @IsOptional()
  name?: string;
}

export class CreateTaskDto {
  @ApiProperty({ example: 'Follow up with new lead' })
  @IsString()
  @IsNotEmpty()
  title: string;

  @ApiPropertyOptional({ example: 'Call John Doe regarding his interest' })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiProperty({ example: '2026-03-15T10:00:00Z' })
  @IsDate()
  @Type(() => Date)
  dueDate: Date;

  @ApiPropertyOptional({ example: '60d0fe4f5311236168a109cf' })
  @IsString()
  @IsOptional()
  statusId?: string;

  @ApiProperty({ example: 'HIGH', enum: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] })
  @IsString()
  @IsNotEmpty()
  priority: string;

  @ApiPropertyOptional({ example: '60d0fe4f5311236168a109cd' })
  @IsString()
  @IsOptional()
  categoryId?: string;

  @ApiPropertyOptional({ example: '60d0fe4f5311236168a109cc' })
  @IsString()
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
  @IsOptional()
  tags?: string[];

  @ApiPropertyOptional({ example: '2026-03-14T09:00:00Z' })
  @IsDate()
  @Type(() => Date)
  @IsOptional()
  reminderAt?: Date;

  @ApiPropertyOptional({ example: 'manual' })
  @IsString()
  @IsOptional()
  sourceId?: string;

  @ApiPropertyOptional()
  @IsObject()
  @IsOptional()
  customFields?: Record<string, any>;
}
