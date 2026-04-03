import { IsNotEmpty, IsOptional, IsString, IsArray } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * DTO for creating a Ticket directly from an omni-channel conversation.
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

  @ApiPropertyOptional({
    description: 'Specific message IDs to link to this ticket',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  linkedMessageIds?: string[];
}
