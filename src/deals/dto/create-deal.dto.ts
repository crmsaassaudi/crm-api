import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsNumber,
  IsDate,
  IsArray,
  IsObject,
  IsBoolean,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateDealDto {
  @ApiProperty({ example: 'Enterprise Software License' })
  @IsString()
  @IsNotEmpty()
  title: string;

  @ApiPropertyOptional({ example: 'Full scope project for Acme Corp' })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({ example: 'default' })
  @IsString()
  @IsOptional()
  pipeline?: string;

  @ApiPropertyOptional({ example: '60d0fe4f5311236168a109cf' })
  @IsString()
  @IsOptional()
  stageId?: string;

  /**
   * `@Min(0)`: a negative value is not a deal, and every report sums this field —
   * `$sum: '$value'` in the pipeline, forecast and win-rate aggregations — so one
   * negative row silently reduces a tenant's whole reported pipeline. `@IsNumber`
   * alone accepted it.
   */
  @ApiProperty({ example: 25000 })
  @IsNumber()
  @Min(0)
  value: number;

  /**
   * ISO 4217, upper-cased.
   *
   * `@IsString()` alone accepted `'dollars'`, `'$'`, and `'usd'` alongside `'USD'` —
   * and the case variants alone are enough to split one currency into several buckets
   * the moment reports group by it. Normalising on the way in is the only place this
   * can be fixed once; validating without normalising would just reject the same
   * user's second entry.
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
   * Percent, 0–100.
   *
   * The forecast multiplies `value * probability / 100`, so an unbounded probability
   * is an unbounded forecast: `probability: 500` reports five times the deal's value
   * as expected revenue. Unbounded input into a multiplication that leaves the system
   * as a number a human trusts.
   */
  @ApiPropertyOptional({ example: 50 })
  @IsNumber()
  @Min(0)
  @Max(100)
  @IsOptional()
  probability?: number;

  @ApiPropertyOptional({ example: '60d0fe4f5311236168a109cc' })
  @IsString()
  @IsOptional()
  accountId?: string;

  @ApiPropertyOptional({ example: 'Acme Corp' })
  @IsString()
  @IsOptional()
  accountName?: string;

  @ApiPropertyOptional({ example: ['60d0fe4f5311236168a109ca'] })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  contactIds?: string[];

  @ApiPropertyOptional({ example: '60d0fe4f5311236168a109cb' })
  @IsString()
  @IsOptional()
  ownerId?: string;

  @ApiPropertyOptional({ example: '60d0fe4f5311236168a109cd' })
  @IsString()
  @IsOptional()
  sourceId?: string;

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

  @ApiPropertyOptional()
  @IsObject()
  @IsOptional()
  customFields?: Record<string, any>;

  @ApiPropertyOptional({
    description: 'Pipeline ObjectId (preferred over pipeline string)',
  })
  @IsString()
  @IsOptional()
  pipelineId?: string;

  @ApiPropertyOptional({
    description: 'Omni-conversation this deal was created from',
  })
  @IsString()
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
