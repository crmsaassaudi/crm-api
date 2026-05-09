import {
  IsString,
  IsOptional,
  IsEnum,
  IsObject,
  IsBoolean,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

const PROVIDER_TYPES = ['sendgrid', 'twilio', 'smtp'] as const;
const AUTH_TYPES = ['app_password', 'oauth2'] as const;

export class VerifyAndSaveChannelConfigDto {
  @ApiProperty({ enum: PROVIDER_TYPES })
  @IsEnum(PROVIDER_TYPES)
  providerType: string;

  @ApiProperty({ example: 'Production SendGrid' })
  @IsString()
  @MinLength(1)
  name: string;

  @ApiProperty({
    description: 'Credential fields (apiKey, accountSid, authToken)',
  })
  @IsObject()
  credentials: Record<string, any>;

  @ApiPropertyOptional({
    description: 'Public settings (fromEmail, fromName, fromNumber)',
  })
  @IsObject()
  @IsOptional()
  publicSettings?: Record<string, any>;

  @ApiPropertyOptional({ enum: AUTH_TYPES, default: 'app_password' })
  @IsEnum(AUTH_TYPES)
  @IsOptional()
  authType?: 'app_password' | 'oauth2';

  @ApiPropertyOptional()
  @IsBoolean()
  @IsOptional()
  isDefault?: boolean;
}

export class UpdateChannelConfigDto {
  @ApiPropertyOptional()
  @IsString()
  @MinLength(1)
  @IsOptional()
  name?: string;

  @ApiPropertyOptional({
    description: 'New credentials — triggers re-verification',
  })
  @IsObject()
  @IsOptional()
  credentials?: Record<string, any>;

  @ApiPropertyOptional()
  @IsObject()
  @IsOptional()
  publicSettings?: Record<string, any>;

  @ApiPropertyOptional({ enum: AUTH_TYPES })
  @IsEnum(AUTH_TYPES)
  @IsOptional()
  authType?: 'app_password' | 'oauth2';

  @ApiPropertyOptional({ enum: ['active', 'error', 'disabled'] })
  @IsEnum(['active', 'error', 'disabled'])
  @IsOptional()
  status?: string;
}
