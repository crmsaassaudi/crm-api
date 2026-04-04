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

const BREACH_TYPES = ['warning', 'breach'] as const;
const ACTION_TYPES = ['notify', 'reassign', 'escalate', 'color_red'] as const;
const ESCALATE_UNITS = ['minutes', 'hours'] as const;

class EscalationActionDto {
  @ApiProperty({ enum: ACTION_TYPES, example: 'notify' })
  @IsEnum(ACTION_TYPES)
  type: string;

  @ApiProperty({ example: 'manager@company.com' })
  @IsString()
  value: string;
}

export class CreateEscalationPolicyDto {
  @ApiProperty({ example: 'Critical SLA Breach' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name: string;

  @ApiProperty({ example: '507f1f77bcf86cd799439011' })
  @IsString()
  slaId: string;

  @ApiProperty({ enum: BREACH_TYPES, example: 'warning' })
  @IsEnum(BREACH_TYPES)
  breachType: string;

  @ApiProperty({
    example: 5,
    description: 'Time after SLA breach before escalation',
  })
  @IsNumber()
  @Min(0)
  escalateAfter: number;

  @ApiProperty({ enum: ESCALATE_UNITS, example: 'minutes' })
  @IsEnum(ESCALATE_UNITS)
  escalateUnit: string;

  @ApiProperty({ type: [EscalationActionDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => EscalationActionDto)
  actions: EscalationActionDto[];

  @ApiPropertyOptional({ default: true })
  @IsBoolean()
  @IsOptional()
  enabled?: boolean;
}

export class UpdateEscalationPolicyDto {
  @ApiPropertyOptional({ example: 'Updated Policy' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @IsOptional()
  name?: string;

  @ApiPropertyOptional({ example: '507f1f77bcf86cd799439011' })
  @IsString()
  @IsOptional()
  slaId?: string;

  @ApiPropertyOptional({ enum: BREACH_TYPES })
  @IsEnum(BREACH_TYPES)
  @IsOptional()
  breachType?: string;

  @ApiPropertyOptional({ example: 15 })
  @IsNumber()
  @Min(0)
  @IsOptional()
  escalateAfter?: number;

  @ApiPropertyOptional({ enum: ESCALATE_UNITS })
  @IsEnum(ESCALATE_UNITS)
  @IsOptional()
  escalateUnit?: string;

  @ApiPropertyOptional({ type: [EscalationActionDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => EscalationActionDto)
  @IsOptional()
  actions?: EscalationActionDto[];

  @ApiPropertyOptional()
  @IsBoolean()
  @IsOptional()
  enabled?: boolean;
}
