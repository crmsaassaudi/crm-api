import {
  IsArray,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateAiVideoJobDto {
  @ApiProperty({ enum: ['url_import', 'script_production'] })
  @IsEnum(['url_import', 'script_production'])
  sourceType: 'url_import' | 'script_production';

  @ApiPropertyOptional({
    description: 'Public URL of the video (required for url_import)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  sourceUrl?: string;

  @ApiPropertyOptional({
    description:
      'Text script for TTS generation (required for script_production)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  scriptText?: string;

  @ApiPropertyOptional({
    description: 'Library caption/description for reuse in social-posts',
  })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  caption?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  hashtags?: string[];
}

export class RejectJobDto {
  @ApiProperty({ description: 'Reason for rejecting the video' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  reason: string;
}

export class GenerateContentDto {
  @ApiPropertyOptional({ description: 'Optional instruction/prompt for AI' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  prompt?: string;
}
