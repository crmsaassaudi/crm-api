import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
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
