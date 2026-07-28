import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsObject,
  Min,
  MaxLength,
} from 'class-validator';
import { AbacCondition } from './abac.evaluator';

export class CreateAccessPolicyDto {
  @ApiProperty({ example: 'Lock closed deals' })
  @IsString()
  @MaxLength(120)
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiProperty({ example: 'deals', description: "Resource key or '*'" })
  @IsString()
  resource: string;

  @ApiProperty({ example: 'edit', description: "Action or '*'" })
  @IsString()
  action: string;

  @ApiProperty({ enum: ['allow', 'deny'] })
  @IsEnum(['allow', 'deny'])
  effect: 'allow' | 'deny';

  @ApiProperty({
    description: 'AND-combined conditions',
    example: [{ attribute: 'resource.stage', operator: 'eq', value: 'closed' }],
  })
  @IsArray()
  conditions: AbacCondition[];

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @ApiPropertyOptional({ default: 100 })
  @IsOptional()
  @IsInt()
  priority?: number;
}

export class UpdateAccessPolicyDto extends PartialType(CreateAccessPolicyDto) {}

export class SimulateAccessPolicyDto {
  @ApiProperty({ type: CreateAccessPolicyDto })
  @IsObject()
  policy: CreateAccessPolicyDto;

  @ApiProperty({
    example: {
      subject: { id: 'user-id', principalType: 'user' },
      resource: { stage: 'closed' },
      env: { now: '2026-07-28T12:00:00.000Z' },
    },
  })
  @IsObject()
  context: Record<string, Record<string, unknown>>;
}

export class RollbackAccessPolicyDto {
  @ApiProperty({ minimum: 1 })
  @IsInt()
  @Min(1)
  revision: number;
}
