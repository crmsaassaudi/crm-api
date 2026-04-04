import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, ValidateIf } from 'class-validator';

/**
 * DTO for updating user-level i18n preferences.
 * Set a field to null to inherit from tenant defaults.
 */
export class UpdateUserI18nPreferencesDto {
  @ApiPropertyOptional({
    description: 'Override locale (null = use tenant default)',
    example: 'vi',
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  locale?: string | null;

  @ApiPropertyOptional({
    description: 'Override IANA timezone (null = use tenant default)',
    example: 'Asia/Ho_Chi_Minh',
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  timezone?: string | null;
}
