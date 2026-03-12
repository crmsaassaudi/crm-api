import {
  IsString,
  IsOptional,
  IsEnum,
  MinLength,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

const TAG_SCOPES = [
  'Contact',
  'Account',
  'Deal',
  'Ticket',
  'Conversation',
  'Task',
] as const;

export class CreateTagDto {
  @ApiProperty({ example: 'VIP' })
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  name: string;

  @ApiPropertyOptional({ example: '#ef4444' })
  @IsString()
  @IsOptional()
  color?: string;

  @ApiProperty({ enum: TAG_SCOPES, example: 'Contact' })
  @IsEnum(TAG_SCOPES)
  scope: string;

  @ApiPropertyOptional({ example: 'Spend > 1000' })
  @IsString()
  @IsOptional()
  autoRule?: string;
}

export class UpdateTagDto {
  @ApiPropertyOptional({ example: 'VIP Gold' })
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  @IsOptional()
  name?: string;

  @ApiPropertyOptional({ example: '#f59e0b' })
  @IsString()
  @IsOptional()
  color?: string;

  @ApiPropertyOptional({ example: 'Spend > 5000' })
  @IsString()
  @IsOptional()
  autoRule?: string;
}

export class QueryTagDto {
  @ApiPropertyOptional({ enum: TAG_SCOPES })
  @IsEnum(TAG_SCOPES)
  @IsOptional()
  scope?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  search?: string;
}
