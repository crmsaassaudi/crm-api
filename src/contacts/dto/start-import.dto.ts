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

export type DedupMatchingField = 'emails' | 'phones';
export type DedupPolicy = 'skip' | 'overwrite' | 'merge';

export class DeduplicationDto {
  @ApiProperty({
    description: 'Fields used to match an existing contact. Index-backed only.',
    example: ['emails', 'phones'],
    isArray: true,
    enum: ['emails', 'phones'],
  })
  @IsArray()
  @ArrayNotEmpty()
  @IsIn(['emails', 'phones'], { each: true })
  matchingFields: DedupMatchingField[];

  @ApiProperty({ enum: ['skip', 'overwrite', 'merge'], example: 'merge' })
  @IsIn(['skip', 'overwrite', 'merge'])
  policy: DedupPolicy;
}

export class StartImportDto {
  @ApiProperty({
    description: 'Storage key returned by the import upload endpoint.',
    example: 'imports/contacts/01J...-contacts-2026.csv',
  })
  @IsString()
  @IsNotEmpty()
  fileKey: string;

  @ApiProperty({
    description:
      'Map of source column header → Contact field. Must include firstName and lastName.',
    example: {
      'First Name': 'firstName',
      'Last Name': 'lastName',
      'Email Address': 'emails',
      'Mobile Phone': 'phones',
    },
    type: 'object',
    additionalProperties: { type: 'string' },
  })
  @IsObject()
  mapping: Record<string, string>;

  @ApiPropertyOptional({ type: DeduplicationDto })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => DeduplicationDto)
  deduplication?: DeduplicationDto;

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
}
