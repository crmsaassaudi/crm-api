import { IsString, IsOptional, IsBoolean } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { PartialType } from '@nestjs/swagger';
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
  @IsOptional()
  resolutionCodeId?: string;

  @ApiPropertyOptional({ description: 'Internal notes when closing ticket' })
  @IsString()
  @IsOptional()
  resolutionNotes?: string;

  @ApiPropertyOptional({
    description: 'Must be true to reopen a ticket from terminal status',
  })
  @IsBoolean()
  @IsOptional()
  allowReopen?: boolean;
}
