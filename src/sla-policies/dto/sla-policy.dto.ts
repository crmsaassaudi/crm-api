import {
  IsString,
  IsOptional,
  IsEnum,
  IsBoolean,
  IsNumber,
  IsArray,
  ValidateNested,
  MinLength,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';

const SLA_TYPES = ['first_response', 'resolution', 'next_response'] as const;
const TIME_UNITS = ['minutes', 'hours', 'days'] as const;

class SlaTargetDto {
  @ApiProperty({ example: 'Critical' })
  @IsString()
  segment: string;

  @ApiProperty({ example: 4 })
  @IsNumber()
  @Min(1)
  timeValue: number;

  @ApiProperty({ enum: TIME_UNITS, example: 'hours' })
  @IsEnum(TIME_UNITS)
  timeUnit: string;
}

export class CreateSlaPolicyDto {
  @ApiProperty({ example: 'Standard Response SLA' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name: string;

  @ApiProperty({ enum: SLA_TYPES, example: 'first_response' })
  @IsEnum(SLA_TYPES)
  type: string;

  @ApiProperty({ type: [SlaTargetDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SlaTargetDto)
  targets: SlaTargetDto[];

  @ApiPropertyOptional({ default: true })
  @IsBoolean()
  @IsOptional()
  enabled?: boolean;

  @ApiPropertyOptional({ example: 1 })
  @IsNumber()
  @IsOptional()
  priority?: number;
}

export class UpdateSlaPolicyDto {
  @ApiPropertyOptional({ example: 'Premium SLA' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @IsOptional()
  name?: string;

  @ApiPropertyOptional({ type: [SlaTargetDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SlaTargetDto)
  @IsOptional()
  targets?: SlaTargetDto[];

  @ApiPropertyOptional()
  @IsBoolean()
  @IsOptional()
  enabled?: boolean;

  @ApiPropertyOptional()
  @IsNumber()
  @IsOptional()
  priority?: number;
}
