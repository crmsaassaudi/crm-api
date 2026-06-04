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

export type TicketDedupMatchingField = 'externalId' | 'ticketCode';
export type TicketDedupPolicy = 'skip' | 'overwrite' | 'create_new';

export class TicketDeduplicationDto {
  @ApiProperty({
    description: 'Fields used to match an existing ticket.',
    example: ['externalId'],
    isArray: true,
    enum: ['externalId', 'ticketCode'],
  })
  @IsArray()
  @ArrayNotEmpty()
  @IsIn(['externalId', 'ticketCode'], { each: true })
  matchingFields: TicketDedupMatchingField[];

  @ApiProperty({
    enum: ['skip', 'overwrite', 'create_new'],
    example: 'skip',
  })
  @IsIn(['skip', 'overwrite', 'create_new'])
  policy: TicketDedupPolicy;
}

export class StartTicketImportDto {
  @ApiProperty({
    description: 'Storage key returned by the import upload endpoint.',
    example: 'imports/tickets/01J...-tickets-2026.csv',
  })
  @IsString()
  @IsNotEmpty()
  fileKey: string;

  @ApiProperty({
    description:
      'Map of source column header → Ticket field. Must include subject.',
    example: {
      Subject: 'subject',
      Description: 'description',
      Type: 'typeId',
      Priority: 'priority',
    },
    type: 'object',
    additionalProperties: { type: 'string' },
  })
  @IsObject()
  mapping: Record<string, string>;

  @ApiPropertyOptional({ type: TicketDeduplicationDto })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => TicketDeduplicationDto)
  deduplication?: TicketDeduplicationDto;

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
