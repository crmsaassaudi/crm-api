import {
  ApiProperty,
  ApiPropertyOptional,
  OmitType,
  PartialType,
} from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsHexColor,
  IsInt,
  IsMongoId,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class CreateDealStageDto {
  /**
   * `label`, not `name`.
   *
   * The DTO said `name` while the schema requires `label`, so every stage create
   * hit a Mongoose "Path `label` is required" — the settings screen could not add
   * a stage at all.
   */
  @ApiProperty({ example: 'Consultation' })
  @Transform(trim)
  @IsString()
  @Length(1, 80)
  label: string;

  @ApiPropertyOptional({
    description: 'Stable machine name. Derived from the label when omitted.',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 80)
  apiName?: string;

  @ApiProperty({ description: 'Pipeline this stage belongs to' })
  @IsMongoId()
  pipelineId: string;

  /**
   * Percent, 0–100 — the same unit as `deal.probability`, which the forecast
   * divides by 100. The old bound of 0–1 meant a stage could only ever be
   * configured at 0% or 1%.
   */
  @ApiPropertyOptional({ minimum: 0, maximum: 100 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  probability?: number;

  @ApiPropertyOptional({ example: '#3b82f6' })
  @IsOptional()
  @IsHexColor()
  color?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  sortOrder?: number;

  @ApiPropertyOptional({ description: 'Stage new deals land in by default' })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @ApiPropertyOptional({ description: 'Closing into this stage marks a win' })
  @IsOptional()
  @IsBoolean()
  isWon?: boolean;

  @ApiPropertyOptional({ description: 'Closing into this stage marks a loss' })
  @IsOptional()
  @IsBoolean()
  isLost?: boolean;
}

/**
 * `pipelineId` is absent on purpose: moving a stage between pipelines would
 * strand every deal in it. Declared standalone rather than via `PartialType`,
 * because inheriting then re-typing the property keeps the parent's validator
 * metadata and the field stays writable.
 */
export class UpdateDealStageDto extends PartialType(
  OmitType(CreateDealStageDto, ['pipelineId'] as const),
) {}

export class CreateDealSourceDto {
  @ApiProperty({ example: 'Facebook Ads' })
  @Transform(trim)
  @IsString()
  @Length(1, 80)
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  sortOrder?: number;
}

export class UpdateDealSourceDto extends PartialType(CreateDealSourceDto) {}

export class CreatePipelineDto {
  @ApiProperty({ example: 'Retail Sales' })
  @Transform(trim)
  @IsString()
  @Length(1, 80)
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(0, 500)
  description?: string;

  @ApiPropertyOptional({ example: '#3b82f6' })
  @IsOptional()
  @IsHexColor()
  color?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  sortOrder?: number;

  @ApiPropertyOptional({
    description:
      'When true, a deal in this pipeline can only advance one stage at a time. Closing (Won/Lost) and moving backward are always allowed.',
  })
  @IsOptional()
  @IsBoolean()
  enforceSequentialStages?: boolean;
}

export class UpdatePipelineDto extends PartialType(CreatePipelineDto) {}

/** One stage's position, for the drag-to-reorder screen. */
export class ReorderStagesDto {
  @ApiProperty({ type: [String] })
  @IsMongoId({ each: true })
  stageIds: string[];
}
