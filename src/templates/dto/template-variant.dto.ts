import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import {
  TEMPLATE_CHANNELS,
  TEMPLATE_CONTENT_TYPES,
  WHATSAPP_TEMPLATE_CATEGORIES,
} from '../domain/template-variant';

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

/** Only the fields we accept from a caller creating a WhatsApp variant — Meta assigns the rest (externalId/approvalStatus) once submitted. */
class CreateWhatsAppBindingDto {
  @ApiProperty({ enum: WHATSAPP_TEMPLATE_CATEGORIES })
  @IsEnum(WHATSAPP_TEMPLATE_CATEGORIES)
  category: string;

  @ApiProperty({ type: [Object] })
  @IsArray()
  components: any[];
}

export class UpsertTemplateVariantDto {
  @ApiProperty({ enum: TEMPLATE_CHANNELS })
  @IsEnum(TEMPLATE_CHANNELS)
  channel: string;

  @ApiProperty({ example: 'vi' })
  @IsString()
  locale: string;

  @ApiPropertyOptional({ enum: TEMPLATE_CONTENT_TYPES, default: 'text' })
  @IsEnum(TEMPLATE_CONTENT_TYPES)
  @IsOptional()
  contentType?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  subject?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  body?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  htmlContent?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  designJson?: string;

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

  @ApiPropertyOptional({ type: [String] })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  attachments?: string[];

  /** Present only for `channel: 'whatsapp'` — submits the variant to Meta for approval. */
  @ApiPropertyOptional({ type: CreateWhatsAppBindingDto })
  @ValidateNested()
  @Type(() => CreateWhatsAppBindingDto)
  @IsOptional()
  whatsapp?: CreateWhatsAppBindingDto;
}

export class PreviewTemplateDto {
  @ApiProperty({ enum: TEMPLATE_CHANNELS })
  @IsEnum(TEMPLATE_CHANNELS)
  channel: string;

  @ApiProperty({ example: 'vi' })
  @IsString()
  locale: string;
}
