import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsObject,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

export class UpdateEmailIntegrationSettingsDto {
  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  name?: string;

  @ApiPropertyOptional()
  @IsObject()
  @IsOptional()
  publicSettings?: Record<string, any>;

  @ApiPropertyOptional()
  @IsObject()
  @IsOptional()
  emailSettings?: Record<string, any>;
}

export class ReconnectEmailIntegrationDto {
  @ApiPropertyOptional()
  @IsObject()
  @IsOptional()
  credentials?: Record<string, any>;

  @ApiPropertyOptional()
  @IsObject()
  @IsOptional()
  publicSettings?: Record<string, any>;
}

export class TestEmailSyncDto {
  @ApiPropertyOptional({ default: false })
  @IsBoolean()
  @IsOptional()
  startBackfill?: boolean;

  @ApiPropertyOptional({ default: 'auto_discover' })
  @IsString()
  @IsOptional()
  mode?: 'contact_enriched' | 'auto_discover';

  @ApiPropertyOptional({ default: 7 })
  @Min(1)
  @Max(365)
  @IsOptional()
  maxAgeDays?: number;

  @ApiPropertyOptional({ default: 50 })
  @Min(1)
  @Max(500)
  @IsOptional()
  maxThreads?: number;
}
