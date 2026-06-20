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

  // ── Content ─────────────────────────────────────────────────────────
  @ApiPropertyOptional({ example: 'Hi there 👋 How can we help?' })
  @IsString()
  @IsOptional()
  greeting?: string;

  @ApiPropertyOptional({ example: 'Support Team' })
  @IsString()
  @IsOptional()
  agentName?: string;

  @ApiPropertyOptional({ example: 'https://cdn.example.com/avatar.png' })
  @IsString()
  @IsOptional()
  agentAvatar?: string;

  @ApiPropertyOptional({ example: 'https://cdn.example.com/icon.svg' })
  @IsString()
  @IsOptional()
  launcherIconUrl?: string;

  @ApiPropertyOptional({
    example: 'We are offline right now. Leave a message!',
  })
  @IsString()
  @IsOptional()
  offlineMessage?: string;

  // ── Branding / Colors ──────────────────────────────────────────────
  @ApiPropertyOptional({ example: '#6366f1' })
  @IsString()
  @IsOptional()
  brandColor?: string;

  @ApiPropertyOptional({
    example: '#6366f1',
    description: 'Launcher button color (defaults to brandColor)',
  })
  @IsString()
  @IsOptional()
  launcherColor?: string;

  @ApiPropertyOptional({
    example: '#f1f5f9',
    description: 'Agent message bubble background',
  })
  @IsString()
  @IsOptional()
  agentBubbleColor?: string;

  @ApiPropertyOptional({
    example: '#1e293b',
    description: 'Agent message text color',
  })
  @IsString()
  @IsOptional()
  agentTextColor?: string;

  // ── Typography / Shape ──────────────────────────────────────────────
  @ApiPropertyOptional({ example: 'Inter', description: 'Font family name' })
  @IsString()
  @IsOptional()
  fontFamily?: string;

  @ApiPropertyOptional({
    example: 16,
    description: 'Widget border-radius in px',
  })
  @IsOptional()
  borderRadius?: number;

  @ApiPropertyOptional({
    example: 56,
    description: 'Launcher button size in px',
  })
  @IsOptional()
  launcherSize?: number;

  // ── Behavior ────────────────────────────────────────────────────
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
    example: false,
    description: 'Auto-open widget on page load',
  })
  @IsOptional()
  autoOpen?: boolean;

  @ApiPropertyOptional({ example: 3000, description: 'Auto-open delay in ms' })
  @IsOptional()
  autoOpenDelay?: number;

  @ApiPropertyOptional({
    example: true,
    description: 'Show Powered by CRM branding',
  })
  @IsOptional()
  showBranding?: boolean;

  // ── Advanced ──────────────────────────────────────────────────────
  @ApiPropertyOptional({ description: 'Custom CSS injected into Shadow DOM' })
  @IsString()
  @IsOptional()
  customCSS?: string;
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
