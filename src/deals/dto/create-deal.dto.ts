import {
  IsArray,
  IsBoolean,
  IsDate,
  IsMongoId,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** UTM values arrive from ad platforms; normalise so one campaign is one bucket. */
const normaliseUtm = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() || null : value;

export class CreateDealDto {
  @ApiProperty({ example: 'Enterprise Software License' })
  @IsString()
  @IsNotEmpty()
  @Length(1, 200)
  title: string;

  @ApiPropertyOptional({ example: 'Full scope project for Acme Corp' })
  @IsString()
  @IsOptional()
  @Length(0, 5000)
  description?: string;

  @ApiPropertyOptional({
    description: 'Defaults to the tenant default pipeline when omitted.',
  })
  @IsMongoId()
  @IsOptional()
  pipelineId?: string;

  @ApiPropertyOptional({
    description: "Defaults to the pipeline's first stage when omitted.",
  })
  @IsMongoId()
  @IsOptional()
  stageId?: string;

  /**
   * `@Min(0)`: a negative value is not a deal, and every report sums this field,
   * so one negative row silently reduces a tenant's whole reported pipeline.
   */
  @ApiProperty({ example: 25000 })
  @IsNumber()
  @Min(0)
  value: number;

  /**
   * ISO 4217, upper-cased.
   *
   * `@IsString()` alone accepted `'dollars'`, `'$'` and `'usd'` alongside `'USD'`,
   * and the case variants alone split one currency into several buckets the
   * moment a report groups by it. Normalising on the way in is the only place
   * this can be fixed once.
   */
  @ApiPropertyOptional({ example: 'USD' })
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsString()
  @Matches(/^[A-Z]{3}$/, {
    message: 'currency must be a 3-letter ISO 4217 code, e.g. USD',
  })
  currency?: string;

  /**
   * Percent, 0–100. The forecast multiplies `value * probability / 100`, so an
   * unbounded probability is an unbounded forecast. Defaults to the stage's own
   * probability when omitted.
   */
  @ApiPropertyOptional({ example: 50 })
  @IsNumber()
  @Min(0)
  @Max(100)
  @IsOptional()
  probability?: number;

  @ApiPropertyOptional({ example: '60d0fe4f5311236168a109cc' })
  @IsMongoId()
  @IsOptional()
  accountId?: string;

  @ApiPropertyOptional({ example: 'Acme Corp' })
  @IsString()
  @IsOptional()
  @Length(0, 200)
  accountName?: string;

  @ApiPropertyOptional({ example: ['60d0fe4f5311236168a109ca'] })
  @IsArray()
  @IsMongoId({ each: true })
  @IsOptional()
  contactIds?: string[];

  @ApiPropertyOptional({ example: '60d0fe4f5311236168a109cb' })
  @IsMongoId()
  @IsOptional()
  ownerId?: string;

  @ApiPropertyOptional({ example: '60d0fe4f5311236168a109cd' })
  @IsMongoId()
  @IsOptional()
  sourceId?: string;

  @ApiPropertyOptional({ example: 'facebook' })
  @IsOptional()
  @Transform(normaliseUtm)
  @IsString()
  @Length(0, 120)
  utmSource?: string;

  @ApiPropertyOptional({ example: 'cpc' })
  @IsOptional()
  @Transform(normaliseUtm)
  @IsString()
  @Length(0, 120)
  utmMedium?: string;

  @ApiPropertyOptional({ example: 'ramadan-2026' })
  @IsOptional()
  @Transform(normaliseUtm)
  @IsString()
  @Length(0, 120)
  utmCampaign?: string;

  @ApiPropertyOptional({ example: ['enterprise'] })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  tags?: string[];

  @ApiPropertyOptional({ example: '2026-06-30T00:00:00Z' })
  @IsDate()
  @Type(() => Date)
  @IsOptional()
  closeDate?: Date;

  @ApiPropertyOptional({
    description: 'When the owner will next touch this deal.',
    example: '2026-08-07T09:00:00Z',
  })
  @IsDate()
  @Type(() => Date)
  @IsOptional()
  nextFollowUpAt?: Date | null;

  @ApiPropertyOptional()
  @IsObject()
  @IsOptional()
  customFields?: Record<string, any>;

  @ApiPropertyOptional({
    description: 'Omni-conversation this deal was created from',
  })
  @IsMongoId()
  @IsOptional()
  omniConversationId?: string;

  @ApiPropertyOptional({
    description:
      'Bypasses the same-title/same-account duplicate check. Titles legitimately repeat, so this is a warning, not a hard constraint.',
  })
  @IsBoolean()
  @IsOptional()
  allowDuplicate?: boolean;
}
