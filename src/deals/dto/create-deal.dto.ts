import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsNumber,
  IsDate,
  IsArray,
  IsObject,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateDealDto {
  @ApiProperty({ example: 'Enterprise Software License' })
  @IsString()
  @IsNotEmpty()
  title: string;

  @ApiPropertyOptional({ example: 'Full scope project for Acme Corp' })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({ example: 'default' })
  @IsString()
  @IsOptional()
  pipeline?: string;

  @ApiPropertyOptional({ example: '60d0fe4f5311236168a109cf' })
  @IsString()
  @IsOptional()
  stageId?: string;

  @ApiProperty({ example: 25000 })
  @IsNumber()
  value: number;

  @ApiPropertyOptional({ example: 'USD' })
  @IsString()
  @IsOptional()
  currency?: string;

  @ApiPropertyOptional({ example: 50 })
  @IsNumber()
  @IsOptional()
  probability?: number;

  @ApiPropertyOptional({ example: '60d0fe4f5311236168a109cc' })
  @IsString()
  @IsOptional()
  accountId?: string;

  @ApiPropertyOptional({ example: 'Acme Corp' })
  @IsString()
  @IsOptional()
  accountName?: string;

  @ApiPropertyOptional({ example: ['60d0fe4f5311236168a109ca'] })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  contactIds?: string[];

  @ApiPropertyOptional({ example: '60d0fe4f5311236168a109cb' })
  @IsString()
  @IsOptional()
  ownerId?: string;

  @ApiPropertyOptional({ example: '60d0fe4f5311236168a109cd' })
  @IsString()
  @IsOptional()
  sourceId?: string;

  @ApiPropertyOptional({ example: ['enterprise'] })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  tags?: string[];

  @ApiPropertyOptional({ example: '2026-06-30T00:00:00Z' })
  @IsDate()
  @Type(() => Date)
  @IsOptional()
  closeDate?: Date;

  @ApiPropertyOptional()
  @IsObject()
  @IsOptional()
  customFields?: Record<string, any>;
}
