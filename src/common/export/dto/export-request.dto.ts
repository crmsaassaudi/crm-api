import {
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ExportFormat } from '../types';

export class ExportRequestFilterItem {
  @IsString()
  id: string;

  @IsOptional()
  value: unknown;
}

/**
 * Generic export request body shared by modules that export whole collections
 * (accounts/deals/tickets). Contacts keeps its richer ExportContactsDto.
 */
export class ExportRequestDto {
  @ApiPropertyOptional({
    description: 'Specific record IDs to export. Omit to export all.',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  ids?: string[];

  @ApiPropertyOptional({ description: 'Output format', enum: ['csv', 'xlsx'] })
  @IsOptional()
  @IsIn(['csv', 'xlsx'])
  format?: ExportFormat;

  @ApiPropertyOptional({
    description: 'Subset of column keys to export. Omit for all columns.',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  columns?: string[];

  @ApiPropertyOptional({ description: 'Exact list filters captured by the UI' })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ExportRequestFilterItem)
  filters?: ExportRequestFilterItem[];

  @ApiPropertyOptional({ description: 'Exact list search captured by the UI' })
  @IsOptional()
  @IsString()
  search?: string;
}
