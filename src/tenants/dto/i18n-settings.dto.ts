import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';

const SUPPORTED_LOCALES = [
  'en',
  'vi',
  'fr',
  'es',
  'zh',
  'ar',
  'hi',
  'uk',
] as const;

const SUPPORTED_DATE_FORMATS = [
  'DD/MM/YYYY',
  'MM/DD/YYYY',
  'YYYY-MM-DD',
] as const;

const SUPPORTED_CURRENCIES = [
  'USD',
  'VND',
  'EUR',
  'GBP',
  'JPY',
  'CNY',
  'KRW',
  'THB',
  'SAR',
  'AED',
] as const;

/**
 * DTO for updating tenant-level i18n defaults.
 * All fields optional — only provided fields are updated.
 */
export class UpdateTenantI18nDto {
  @ApiPropertyOptional({
    description: 'Default locale (BCP-47)',
    example: 'vi',
    enum: SUPPORTED_LOCALES,
  })
  @IsOptional()
  @IsIn(SUPPORTED_LOCALES)
  locale?: string;

  @ApiPropertyOptional({
    description: 'Default IANA timezone',
    example: 'Asia/Ho_Chi_Minh',
  })
  @IsOptional()
  @IsString()
  timezone?: string;

  @ApiPropertyOptional({
    description: 'Date display format',
    example: 'DD/MM/YYYY',
    enum: SUPPORTED_DATE_FORMATS,
  })
  @IsOptional()
  @IsIn(SUPPORTED_DATE_FORMATS)
  dateFormat?: string;

  @ApiPropertyOptional({
    description: 'Default currency (ISO 4217)',
    example: 'VND',
    enum: SUPPORTED_CURRENCIES,
  })
  @IsOptional()
  @IsIn(SUPPORTED_CURRENCIES)
  currency?: string;
}
