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

export type AccountDedupMatchingField = 'name' | 'emails' | 'taxId';
export type AccountDedupPolicy = 'skip' | 'overwrite' | 'merge';

export class AccountDeduplicationDto {
  @ApiProperty({
    description: 'Fields used to match an existing account. Index-backed only.',
    example: ['name', 'emails'],
    isArray: true,
    enum: ['name', 'emails', 'taxId'],
  })
  @IsArray()
  @ArrayNotEmpty()
  @IsIn(['name', 'emails', 'taxId'], { each: true })
  matchingFields: AccountDedupMatchingField[];

  @ApiProperty({ enum: ['skip', 'overwrite', 'merge'], example: 'skip' })
  @IsIn(['skip', 'overwrite', 'merge'])
  policy: AccountDedupPolicy;
}

export class StartAccountImportDto {
  @ApiProperty({
    description: 'Storage key returned by the import upload endpoint.',
    example: 'imports/accounts/01J...-accounts-2026.csv',
  })
  @IsString()
  @IsNotEmpty()
  fileKey: string;

  @ApiProperty({
    description:
      'Map of source column header → Account field. Must include name.',
    example: {
      'Company Name': 'name',
      Website: 'website',
      Industry: 'industry',
      Email: 'emails',
    },
    type: 'object',
    additionalProperties: { type: 'string' },
  })
  @IsObject()
  mapping: Record<string, string>;

  @ApiPropertyOptional({ type: AccountDeduplicationDto })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => AccountDeduplicationDto)
  deduplication?: AccountDeduplicationDto;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  triggerAutomations?: boolean;

  @ApiPropertyOptional({
    description:
      'Client-side row estimate (excluding header) used for accurate progress %.',
  })
  @IsOptional()
  estimatedRows?: number;

  @ApiPropertyOptional({
    description: 'Original file name for display in import history.',
  })
  @IsOptional()
  @IsString()
  fileName?: string;

  @ApiPropertyOptional({
    description: 'File format detected during upload.',
    enum: ['csv', 'xlsx'],
  })
  @IsOptional()
  @IsString()
  fileFormat?: string;
}
