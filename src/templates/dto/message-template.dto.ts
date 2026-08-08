import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  TEMPLATE_PURPOSES,
  TEMPLATE_STATUSES,
  TEMPLATE_VISIBILITIES,
} from '../domain/message-template';

export class CreateMessageTemplateDto {
  @ApiProperty({ example: 'Xác nhận đơn hàng' })
  @IsString()
  @MinLength(1)
  @MaxLength(150)
  name: string;

  @ApiProperty({ enum: TEMPLATE_PURPOSES, isArray: true })
  @IsArray()
  @IsEnum(TEMPLATE_PURPOSES, { each: true })
  purpose: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  tags?: string[];

  @ApiPropertyOptional({ enum: TEMPLATE_VISIBILITIES, default: 'tenant' })
  @IsEnum(TEMPLATE_VISIBILITIES)
  @IsOptional()
  visibility?: string;

  @ApiPropertyOptional({ example: '/hi' })
  @IsString()
  @MaxLength(20)
  @IsOptional()
  shortcut?: string;
}

export class UpdateMessageTemplateDto {
  @ApiPropertyOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(150)
  @IsOptional()
  name?: string;

  @ApiPropertyOptional({ enum: TEMPLATE_PURPOSES, isArray: true })
  @IsArray()
  @IsEnum(TEMPLATE_PURPOSES, { each: true })
  @IsOptional()
  purpose?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  tags?: string[];

  @ApiPropertyOptional({ enum: TEMPLATE_STATUSES })
  @IsEnum(TEMPLATE_STATUSES)
  @IsOptional()
  status?: string;

  @ApiPropertyOptional({ enum: TEMPLATE_VISIBILITIES })
  @IsEnum(TEMPLATE_VISIBILITIES)
  @IsOptional()
  visibility?: string;

  @ApiPropertyOptional()
  @IsString()
  @MaxLength(20)
  @IsOptional()
  shortcut?: string;
}

export class QueryMessageTemplateDto {
  @ApiPropertyOptional({ enum: TEMPLATE_PURPOSES })
  @IsEnum(TEMPLATE_PURPOSES)
  @IsOptional()
  purpose?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  channel?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  contentType?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  tag?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  search?: string;
}
