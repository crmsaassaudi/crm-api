import {
  IsString,
  IsOptional,
  IsBoolean,
  IsInt,
  IsMongoId,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { CreateTicketDto } from './create-ticket.dto';

/**
 * DTO for updating a ticket via PATCH /tickets/:id.
 *
 * Extends CreateTicketDto (all fields become optional via PartialType)
 * and adds update-only fields like resolution and reopen control.
 */
export class UpdateTicketDto extends PartialType(CreateTicketDto) {
  @ApiPropertyOptional({ description: 'TicketResolutionCode ObjectId' })
  @IsString()
  @IsMongoId()
  @IsOptional()
  resolutionCodeId?: string;

  @ApiPropertyOptional({ description: 'Internal notes when closing ticket' })
  @IsString()
  @MaxLength(20_000)
  @IsOptional()
  resolutionNotes?: string;

  @ApiPropertyOptional({
    description: 'Must be true to reopen a ticket from terminal status',
  })
  @IsBoolean()
  @IsOptional()
  allowReopen?: boolean;

  /**
   * The document version the client last read.
   *
   * Two agents on one ticket is the normal case in a contact centre, and
   * without this the second save silently overwrote the first. Optional
   * because server-side callers (automation, the SLA projector) write disjoint
   * fields and hold no read to compare against; every client sends it.
   */
  @ApiPropertyOptional({ description: 'Version read by the client (__v)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  version?: number;
}
