import {
  IsString,
  IsOptional,
  IsEnum,
  IsObject,
  MinLength,
  IsArray,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

const CHANNEL_TYPES = [
  'facebook',
  'zalo',
  'whatsapp',
  'livechat',
  'instagram',
  'tiktok',
  'shopee',
  'email',
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

export class CreateLivechatChannelDto {
  @ApiProperty({ example: 'Website Support' })
  @IsString()
  @MinLength(1)
  name: string;

  @ApiPropertyOptional({ example: 'Hi there 👋 How can we help?' })
  @IsString()
  @IsOptional()
  greeting?: string;

  @ApiPropertyOptional({ example: '#6366f1' })
  @IsString()
  @IsOptional()
  brandColor?: string;

  @ApiPropertyOptional({ example: 'Support Team' })
  @IsString()
  @IsOptional()
  agentName?: string;

  @ApiPropertyOptional({ example: 'https://cdn.example.com/avatar.png' })
  @IsString()
  @IsOptional()
  agentAvatar?: string;

  @ApiPropertyOptional({ example: 'bottom-right' })
  @IsString()
  @IsOptional()
  position?: string;

  @ApiPropertyOptional({ type: [String], example: ['https://mysite.com'] })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  allowedOrigins?: string[];

  @ApiPropertyOptional({
    example: 'We are offline right now. Leave a message!',
  })
  @IsString()
  @IsOptional()
  offlineMessage?: string;
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

export class MetaAuthUrlQueryDto {
  @ApiPropertyOptional({ enum: ['fb', 'ig', 'wa', 'fb_ig'] })
  @IsEnum(['fb', 'ig', 'wa', 'fb_ig'])
  @IsOptional()
  type?: 'fb' | 'ig' | 'wa' | 'fb_ig';

  @ApiPropertyOptional({ example: 'https://tenant.crmsaudi.dev' })
  @IsString()
  @IsOptional()
  openerOrigin?: string;
}

export class ConnectMetaChannelsDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  resultId: string;

  @ApiProperty({ type: [String] })
  @IsArray()
  @IsString({ each: true })
  selectedAccountIds: string[];
}
