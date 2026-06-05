import {
  IsOptional,
  IsArray,
  IsString,
  IsIn,
  ValidateNested,
  IsBoolean,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Typed filter item for contact export.
 * Prevents arbitrary field injection into MongoDB queries.
 */
class ExportFilterItem {
  @IsString()
  id: string;

  @IsOptional()
  value: any;
}

/**
 * DTO for the POST /contacts/export endpoint.
 * Replaces the unvalidated `{ ids?: string[]; filters?: any }` inline type.
 */
export class ExportContactsDto {
  @ApiPropertyOptional({
    description: 'Specific contact IDs to export. Omit to export by filters.',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  ids?: string[];

  @ApiPropertyOptional({ description: 'Output format', enum: ['csv', 'xlsx'] })
  @IsOptional()
  @IsIn(['csv', 'xlsx'])
  format?: 'csv' | 'xlsx';

  @ApiPropertyOptional({
    description: 'Subset of column keys to export. Omit for all columns.',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  columns?: string[];

  @ApiPropertyOptional({
    description: 'Filter criteria for the export',
  })
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => ExportFilterItem)
  @IsArray()
  filters?: ExportFilterItem[];

  @ApiPropertyOptional({
    description: 'Lifecycle stage filter',
  })
  @IsOptional()
  @IsString()
  lifecycleStage?: string;

  @ApiPropertyOptional({
    description: 'Search text',
  })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({
    description: 'Restrict to contacts owned by current user',
  })
  @IsOptional()
  @IsBoolean()
  restrictToOwner?: boolean;
}
