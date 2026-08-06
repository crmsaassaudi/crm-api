import {
  IsOptional,
  IsArray,
  IsString,
  IsIn,
  IsMongoId,
  ValidateNested,
  IsBoolean,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Typed filter item for contact export.
 *
 * Accepts both the legacy `{id, value}` shape and the operator form
 * `{field, operator, value}` — the compiler in `filters/contact-filter` decides
 * which fields and operators are legal, so validating that here would be a
 * second rule to keep in step. Field injection is prevented there.
 */
class ExportFilterItem {
  @IsOptional()
  @IsString()
  id?: string;

  @IsOptional()
  @IsString()
  field?: string;

  @IsOptional()
  @IsString()
  operator?: string;

  @IsOptional()
  value?: any;
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
    description:
      'Export the members of a saved segment. Composed with the other filters.',
  })
  @IsOptional()
  @IsMongoId()
  segmentId?: string;

  @ApiPropertyOptional({
    description: 'Restrict to contacts owned by current user',
  })
  @IsOptional()
  @IsBoolean()
  restrictToOwner?: boolean;
}
