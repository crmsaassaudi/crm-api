import {
  IsNotEmpty,
  IsOptional,
  IsString,
  IsArray,
  IsObject,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * DTO for creating a Ticket directly from an omni-channel conversation.
 *
 * Supports the FULL ticket model to ensure parity with the standard
 * ticket creation form (POST /tickets). All optional fields fall back
 * to sensible defaults in ConversionService if not provided.
 */
export class CreateTicketFromConversationDto {
  @ApiProperty({ description: 'Subject of the ticket' })
  @IsNotEmpty()
  @IsString()
  subject: string;

  @ApiPropertyOptional({ description: 'Detailed description' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ description: 'Priority level', default: 'MEDIUM' })
  @IsOptional()
  @IsString()
  priority?: string;

  @ApiPropertyOptional({ description: 'Ticket Type ID (from ticket-settings)' })
  @IsOptional()
  @IsString()
  typeId?: string;

  @ApiPropertyOptional({
    description: 'Ticket Status ID (from ticket-settings)',
  })
  @IsOptional()
  @IsString()
  statusId?: string;

  @ApiPropertyOptional({
    description: 'Ticket Source ID (from ticket-settings)',
  })
  @IsOptional()
  @IsString()
  sourceId?: string;

  @ApiPropertyOptional({
    description: 'N-level category path (array of node IDs)',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  categoryPath?: string[];

  @ApiPropertyOptional({ description: 'Assigned Group ID' })
  @IsOptional()
  @IsString()
  groupId?: string;

  @ApiPropertyOptional({ description: 'Assigned Owner/Agent ID' })
  @IsOptional()
  @IsString()
  ownerId?: string;

  @ApiPropertyOptional({ description: 'Custom fields key-value pairs' })
  @IsOptional()
  @IsObject()
  customFields?: Record<string, any>;

  @ApiPropertyOptional({
    description: 'Specific message IDs to link to this ticket',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  linkedMessageIds?: string[];
}
