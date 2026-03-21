import {
  IsString,
  IsOptional,
  IsEnum,
  IsObject,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

const CHANNEL_TYPES = [
  'Facebook',
  'Zalo',
  'WhatsApp',
  'LiveChat',
  'Instagram',
  'TikTok',
  'Shopee',
  'Email',
] as const;

export class CreateChannelDto {
  @ApiProperty({ enum: CHANNEL_TYPES })
  @IsEnum(CHANNEL_TYPES)
  type: string;

  @ApiProperty({ example: 'Facebook Page A' })
  @IsString()
  @MinLength(1)
  name: string;

  @ApiProperty({ example: 'page_a' })
  @IsString()
  @MinLength(1)
  account: string;

  @ApiPropertyOptional()
  @IsObject()
  @IsOptional()
  config?: Record<string, any>;

  @ApiPropertyOptional()
  @IsObject()
  @IsOptional()
  credentials?: Record<string, any>;
}

export class UpdateChannelDto {
  @ApiPropertyOptional()
  @IsString()
  @MinLength(1)
  @IsOptional()
  name?: string;

  @ApiPropertyOptional()
  @IsObject()
  @IsOptional()
  config?: Record<string, any>;

  @ApiPropertyOptional({
    enum: ['Connected', 'Disconnected', 'Error', 'Pending'],
  })
  @IsEnum(['Connected', 'Disconnected', 'Error', 'Pending'])
  @IsOptional()
  status?: string;
}
