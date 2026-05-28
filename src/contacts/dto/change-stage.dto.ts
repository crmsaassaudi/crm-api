import {
  IsString,
  IsOptional,
  IsBoolean,
  IsObject,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Typed account data for stage change.
 * Prevents arbitrary object injection.
 */
class AccountDataDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  industry?: string;

  @IsOptional()
  @IsString()
  website?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  address?: string;
}

/**
 * Typed deal data for stage change.
 */
class DealDataDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  pipelineId?: string;

  @IsOptional()
  @IsString()
  stageId?: string;

  @IsOptional()
  amount?: number;
}

/**
 * DTO for POST /contacts/:id/change-stage.
 * Replaces the unvalidated inline body type with strict validation.
 */
export class ChangeStageDto {
  @ApiProperty({ description: 'Target lifecycle stage ID or apiName' })
  @IsString()
  stage: string;

  @ApiPropertyOptional({
    description: 'Whether to auto-create an account for this contact',
  })
  @IsOptional()
  @IsBoolean()
  createAccount?: boolean;

  @ApiPropertyOptional({ description: 'Link to existing account ID' })
  @IsOptional()
  @IsString()
  accountId?: string;

  @ApiPropertyOptional({ description: 'Data for auto-created account' })
  @IsOptional()
  @ValidateNested()
  @Type(() => AccountDataDto)
  @IsObject()
  accountData?: AccountDataDto;

  @ApiPropertyOptional({ description: 'Data for auto-created deal' })
  @IsOptional()
  @ValidateNested()
  @Type(() => DealDataDto)
  @IsObject()
  dealData?: DealDataDto;

  @ApiPropertyOptional({ description: 'Reason for stage change' })
  @IsOptional()
  @IsString()
  reason?: string;
}
