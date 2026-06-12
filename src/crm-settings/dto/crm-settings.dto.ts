import { ApiProperty, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsHexColor,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';

/**
 * DTOs for the lifecycle stage/status mutation endpoints on CrmSettingsController.
 *
 * The global ValidationPipe runs with `whitelist: true` + `forbidNonWhitelisted: true`,
 * so EVERY field consumed by CrmSettingsService.createLifecycleStage /
 * updateLifecycleStage / createLifecycleStatus / updateLifecycleStatus must be
 * declared here, otherwise it would be stripped (silent data loss) or rejected.
 * Keep these field lists in sync with LIFECYCLE_STAGE_MUTABLE_FIELDS /
 * LIFECYCLE_STATUS_MUTABLE_FIELDS in crm-settings.service.ts.
 */

// ── Lifecycle Status ────────────────────────────────────────────────────────

export class LifecycleStatusDto {
  @ApiProperty()
  @IsString()
  @Length(1, 120)
  label: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @Length(1, 120)
  apiName?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000)
  sortOrder?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsHexColor()
  color?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  isTerminal?: boolean;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  isWon?: boolean;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  probability?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100_000)
  daysInStage?: number;
}

export class UpdateLifecycleStatusDto extends PartialType(LifecycleStatusDto) {}

// ── Lifecycle Stage ─────────────────────────────────────────────────────────

export class LifecycleStageDto {
  @ApiProperty()
  @IsString()
  @Length(1, 120)
  name: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @Length(1, 120)
  apiName?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000)
  sortOrder?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsHexColor()
  color?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @Length(0, 2_000)
  description?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  isTerminal?: boolean;

  @ApiProperty({ required: false, type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  mandatoryFields?: string[];

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  triggerDealCreation?: boolean;

  @ApiProperty({ required: false, type: [LifecycleStatusDto] })
  @IsOptional()
  @IsArray()
  @Type(() => LifecycleStatusDto)
  statuses?: LifecycleStatusDto[];
}

export class UpdateLifecycleStageDto extends PartialType(LifecycleStageDto) {}
