import {
  IsString,
  IsOptional,
  IsEnum,
  IsBoolean,
  IsNumber,
  IsArray,
  ArrayMinSize,
  ValidateNested,
  MinLength,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';

const SLA_TYPES = ['first_response', 'resolution', 'next_response'] as const;
const TIME_UNITS = ['minutes', 'hours', 'days'] as const;
const SLA_APPLIES_TO = ['conversation', 'ticket'] as const;

class SlaTargetDto {
  /**
   * Which slice of work this target covers — the ticket priority on a ticket
   * policy. Omit for the policy's catch-all target.
   */
  @ApiPropertyOptional({ example: 'HIGH' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  segment?: string | null;

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

  @ApiProperty({ enum: SLA_APPLIES_TO, example: 'ticket' })
  @IsEnum(SLA_APPLIES_TO)
  appliesTo: 'conversation' | 'ticket';

  @ApiProperty({ enum: SLA_TYPES, example: 'first_response' })
  @IsEnum(SLA_TYPES)
  type: string;

  @ApiProperty({ type: [SlaTargetDto] })
  @IsArray()
  @ArrayMinSize(1)
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
