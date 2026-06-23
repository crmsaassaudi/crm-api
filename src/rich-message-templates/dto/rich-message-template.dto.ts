import {
  IsString,
  IsOptional,
  IsEnum,
  IsArray,
  IsBoolean,
  MinLength,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';

const TEMPLATE_TYPES = ['interactive', 'carousel'] as const;
const TEMPLATE_SCOPES = ['Public', 'Private'] as const;

class ButtonDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  id: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title: string;
}

class CardDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  title: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  subtitle?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  imageUrl?: string;

  @ApiPropertyOptional({ type: [ButtonDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ButtonDto)
  @IsOptional()
  buttons?: ButtonDto[];
}

export class CreateRichMessageTemplateDto {
  @ApiProperty({ example: 'Xác nhận đơn hàng' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name: string;

  @ApiPropertyOptional({ example: '/confirm' })
  @IsString()
  @IsOptional()
  @MaxLength(30)
  shortcut?: string;

  @ApiProperty({ enum: TEMPLATE_TYPES })
  @IsEnum(TEMPLATE_TYPES)
  type: string;

  @ApiPropertyOptional({ type: [String] })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  channelTypes?: string[];

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  body?: string;

  @ApiPropertyOptional({ type: [ButtonDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ButtonDto)
  @IsOptional()
  buttons?: ButtonDto[];

  @ApiPropertyOptional({ type: [CardDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CardDto)
  @IsOptional()
  cards?: CardDto[];

  @ApiProperty({ enum: TEMPLATE_SCOPES, example: 'Public' })
  @IsEnum(TEMPLATE_SCOPES)
  scope: string;

  @ApiPropertyOptional()
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

export class UpdateRichMessageTemplateDto {
  @ApiPropertyOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @IsOptional()
  name?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MaxLength(30)
  shortcut?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  channelTypes?: string[];

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  body?: string;

  @ApiPropertyOptional({ type: [ButtonDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ButtonDto)
  @IsOptional()
  buttons?: ButtonDto[];

  @ApiPropertyOptional({ type: [CardDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CardDto)
  @IsOptional()
  cards?: CardDto[];

  @ApiPropertyOptional({ enum: TEMPLATE_SCOPES })
  @IsEnum(TEMPLATE_SCOPES)
  @IsOptional()
  scope?: string;

  @ApiPropertyOptional()
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

export class QueryRichMessageTemplateDto {
  @ApiPropertyOptional({ enum: TEMPLATE_TYPES })
  @IsEnum(TEMPLATE_TYPES)
  @IsOptional()
  type?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  channelType?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  search?: string;
}
