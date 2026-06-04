import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export type DealDedupMatchingField = 'title' | 'externalId';
export type DealDedupPolicy = 'skip' | 'overwrite' | 'create_new';

export class DealDeduplicationDto {
  @ApiProperty({
    description: 'Fields used to match an existing deal.',
    example: ['title'],
    isArray: true,
    enum: ['title', 'externalId'],
  })
  @IsArray()
  @ArrayNotEmpty()
  @IsIn(['title', 'externalId'], { each: true })
  matchingFields: DealDedupMatchingField[];

  @ApiProperty({ enum: ['skip', 'overwrite', 'create_new'], example: 'skip' })
  @IsIn(['skip', 'overwrite', 'create_new'])
  policy: DealDedupPolicy;
}

export class StartDealImportDto {
  @ApiProperty({
    description: 'Storage key returned by the import upload endpoint.',
    example: 'imports/deals/01J...-deals-2026.csv',
  })
  @IsString()
  @IsNotEmpty()
  fileKey: string;

  @ApiProperty({
    description:
      'Map of source column header → Deal field. Must include title.',
    example: {
      'Deal Name': 'title',
      Pipeline: 'pipeline',
      Stage: 'stageId',
      Value: 'value',
    },
    type: 'object',
    additionalProperties: { type: 'string' },
  })
  @IsObject()
  mapping: Record<string, string>;

  @ApiPropertyOptional({ type: DealDeduplicationDto })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => DealDeduplicationDto)
  deduplication?: DealDeduplicationDto;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  triggerAutomations?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  estimatedRows?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  fileName?: string;

  @ApiPropertyOptional({ enum: ['csv', 'xlsx'] })
  @IsOptional()
  @IsString()
  fileFormat?: string;
}
