import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsArray,
  IsObject,
  IsIn,
  IsMongoId,
  ArrayMaxSize,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';

export class TicketRelatedToDto {
  @IsString()
  @IsIn(['Deal', 'Ticket', 'Contact', 'Account', 'Task'])
  @MaxLength(50)
  type: string;

  @IsMongoId()
  _id: string;

  @IsOptional()
  @IsMongoId()
  id?: string;

  @IsString()
  @MaxLength(500)
  name: string;
}

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
  @MaxLength(500)
  subject: string;

  @ApiPropertyOptional({ example: 'Detailed description of the issue' })
  @IsString()
  @IsOptional()
  @MaxLength(50_000)
  description?: string;

  // Customer Context
  @ApiPropertyOptional()
  @IsString()
  @IsMongoId()
  @IsOptional()
  contactId?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsMongoId()
  @IsOptional()
  accountId?: string;

  @ApiPropertyOptional({
    description: 'Omni-conversation this ticket was created from',
  })
  @IsString()
  @IsMongoId()
  @IsOptional()
  omniConversationId?: string;

  @ApiPropertyOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsMongoId({ each: true })
  @IsOptional()
  linkedMessageIds?: string[];

  @ApiPropertyOptional()
  @IsString()
  @IsMongoId()
  @IsOptional()
  dealId?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsMongoId()
  @IsOptional()
  parentTicketId?: string;

  @ApiPropertyOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => TicketRelatedToDto)
  @IsOptional()
  relatedTo?: TicketRelatedToDto;

  // Classification & Routing
  @ApiPropertyOptional({ description: 'TicketType ObjectId' })
  @IsString()
  @IsMongoId()
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
  @IsIn(['URGENT', 'HIGH', 'MEDIUM', 'LOW'])
  @IsOptional()
  priority?: string;

  @ApiPropertyOptional({ example: 'omni-channel' })
  @IsString()
  @MaxLength(100)
  @IsOptional()
  channel?: string;

  @ApiPropertyOptional({ description: 'TicketSource ObjectId' })
  @IsString()
  @IsMongoId()
  @IsOptional()
  sourceId?: string;

  @ApiPropertyOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsMongoId({ each: true })
  @IsOptional()
  tags?: string[];

  @ApiPropertyOptional()
  @IsObject()
  @IsOptional()
  customFields?: Record<string, any>;

  // Assignment & Collaboration
  @ApiPropertyOptional({ description: 'Group ObjectId' })
  @IsString()
  @IsMongoId()
  @IsOptional()
  groupId?: string;

  @ApiPropertyOptional({ description: 'Owner (agent) ObjectId' })
  @IsString()
  @IsMongoId()
  @IsOptional()
  ownerId?: string;

  @ApiPropertyOptional({ description: 'TicketStatus ObjectId' })
  @IsString()
  @IsMongoId()
  @IsOptional()
  statusId?: string;
}
