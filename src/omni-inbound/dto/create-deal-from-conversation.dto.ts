import {
  IsNotEmpty,
  IsOptional,
  IsNumber,
  IsString,
  IsArray,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * DTO for creating a Deal directly from an omni-channel conversation.
 */
export class CreateDealFromConversationDto {
  @ApiProperty({ description: 'Title of the deal' })
  @IsNotEmpty()
  @IsString()
  title: string;

  @ApiPropertyOptional({ description: 'Pipeline name', default: 'default' })
  @IsOptional()
  @IsString()
  pipeline?: string;

  @ApiPropertyOptional({ description: 'Pipeline stage', default: 'new' })
  @IsOptional()
  @IsString()
  stage?: string;

  @ApiPropertyOptional({ description: 'Deal value', default: 0 })
  @IsOptional()
  @IsNumber()
  value?: number;

  @ApiPropertyOptional({
    description: 'Specific message IDs to link to this deal',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  linkedMessageIds?: string[];
}
