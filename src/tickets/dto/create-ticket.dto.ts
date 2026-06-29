import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsArray,
  IsObject,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * DTO for creating a ticket via POST /tickets.
 *
 * Enforces structural validation (whitelist + type checks).
 * Business-level required fields (per-tenant config) are enforced
 * by TicketsService after reading tenant layout settings.
 *
 * `subject` is always required (not tenant-configurable).
 */
export class CreateTicketDto {
  @ApiProperty({ example: 'Login page throwing 500 error' })
  @IsString()
  @IsNotEmpty()
  subject: string;

  @ApiPropertyOptional({ example: 'Detailed description of the issue' })
  @IsString()
  @IsOptional()
  description?: string;

  // ── Customer Context ──
  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  contactId?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  accountId?: string;

  @ApiPropertyOptional({
    description: 'Omni-conversation this ticket was created from',
  })
  @IsString()
  @IsOptional()
  omniConversationId?: string;

  @ApiPropertyOptional()
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  linkedMessageIds?: string[];

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  dealId?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  parentTicketId?: string;

  @ApiPropertyOptional()
  @IsObject()
  @IsOptional()
  relatedTo?: { type: string; id?: string; _id: string; name: string };

  // ── Classification & Routing ──
  @ApiPropertyOptional({ description: 'TicketType ObjectId' })
  @IsString()
  @IsOptional()
  typeId?: string;

  @ApiPropertyOptional({
    description: 'N-level category path as array of node IDs',
  })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  categoryPath?: string[];

  @ApiPropertyOptional({ example: 'MEDIUM' })
  @IsString()
  @IsOptional()
  priority?: string;

  @ApiPropertyOptional({ example: 'omni-channel' })
  @IsString()
  @IsOptional()
  channel?: string;

  @ApiPropertyOptional({ description: 'TicketSource ObjectId' })
  @IsString()
  @IsOptional()
  sourceId?: string;

  @ApiPropertyOptional()
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  tags?: string[];

  @ApiPropertyOptional()
  @IsObject()
  @IsOptional()
  customFields?: Record<string, any>;

  // ── Assignment & Collaboration ──
  @ApiPropertyOptional({ description: 'Group ObjectId' })
  @IsString()
  @IsOptional()
  groupId?: string;

  @ApiPropertyOptional({ description: 'Owner (agent) ObjectId' })
  @IsString()
  @IsOptional()
  ownerId?: string;

  @ApiPropertyOptional({ description: 'TicketStatus ObjectId' })
  @IsString()
  @IsOptional()
  statusId?: string;

  @ApiPropertyOptional()
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  watchers?: string[];
}
