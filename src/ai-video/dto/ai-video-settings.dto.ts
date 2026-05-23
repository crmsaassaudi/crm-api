import {
  IsArray,
  IsString,
  IsNumber,
  IsBoolean,
  IsOptional,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateAiVideoSettingsDto {
  @ApiPropertyOptional({ type: [String], example: ['09:00', '12:00', '20:00'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  timeSlots?: string[];

  @ApiPropertyOptional({ example: 30 })
  @IsOptional()
  @IsNumber()
  retainOriginalDays?: number;

  @ApiPropertyOptional({ example: 180 })
  @IsOptional()
  @IsNumber()
  retainProcessedDays?: number;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  autoCleanupTempFiles?: boolean;

  @ApiPropertyOptional({ example: 'your-elevenlabs-key' })
  @IsOptional()
  @IsString()
  elevenLabsApiKey?: string;

  @ApiPropertyOptional({ example: '21m00Tcm4TlvDq8ikWAM' })
  @IsOptional()
  @IsString()
  defaultVoiceId?: string;

  @ApiPropertyOptional({ example: 0.15 })
  @IsOptional()
  @IsNumber()
  bgmVolume?: number;
}
