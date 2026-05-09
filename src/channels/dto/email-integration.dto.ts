import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

const OAUTH2_PROVIDERS = ['google_workspace', 'microsoft_entra'] as const;

export class OAuth2AuthUrlDto {
  @ApiPropertyOptional({ enum: OAUTH2_PROVIDERS })
  @IsEnum(OAUTH2_PROVIDERS)
  provider: 'google_workspace' | 'microsoft_entra';

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  redirectUri?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  state?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  loginHint?: string;
}

export class OAuth2CallbackDto {
  @ApiPropertyOptional({ enum: OAUTH2_PROVIDERS })
  @IsEnum(OAUTH2_PROVIDERS)
  provider: 'google_workspace' | 'microsoft_entra';

  @ApiPropertyOptional()
  @IsString()
  code: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  redirectUri?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  configId?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  name?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  emailAddress?: string;

  @ApiPropertyOptional()
  @IsObject()
  @IsOptional()
  publicSettings?: Record<string, any>;

  @ApiPropertyOptional()
  @IsBoolean()
  @IsOptional()
  isDefault?: boolean;
}

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
