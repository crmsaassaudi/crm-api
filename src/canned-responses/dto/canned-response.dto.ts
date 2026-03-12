import {
  IsString,
  IsOptional,
  IsEnum,
  IsArray,
  MinLength,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

const RESPONSE_SCOPES = ['Public', 'Private', 'Team'] as const;

export class CreateCannedResponseDto {
  @ApiProperty({ example: '/hi' })
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  shortcut: string;

  @ApiProperty({ example: 'Hello! How can I help?' })
  @IsString()
  @MinLength(1)
  content: string;

  @ApiPropertyOptional({ example: 'Greeting' })
  @IsString()
  @IsOptional()
  category?: string;

  @ApiProperty({ enum: RESPONSE_SCOPES, example: 'Public' })
  @IsEnum(RESPONSE_SCOPES)
  scope: string;

  @ApiPropertyOptional({ type: [String] })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  attachments?: string[];
}

export class UpdateCannedResponseDto {
  @ApiPropertyOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  @IsOptional()
  shortcut?: string;

  @ApiPropertyOptional()
  @IsString()
  @MinLength(1)
  @IsOptional()
  content?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  category?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  attachments?: string[];
}

export class QueryCannedResponseDto {
  @ApiPropertyOptional({ enum: RESPONSE_SCOPES })
  @IsEnum(RESPONSE_SCOPES)
  @IsOptional()
  scope?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  category?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  search?: string;
}
