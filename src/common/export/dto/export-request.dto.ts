import { IsArray, IsIn, IsOptional, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { ExportFormat } from '../types';

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
}
