import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional, IsEnum } from 'class-validator';

export class CreateDealActivityDto {
  @ApiProperty({
    enum: ['note', 'call', 'meeting', 'email', 'task'],
    example: 'note',
  })
  @IsEnum(['note', 'call', 'meeting', 'email', 'task'])
  type: string;

  @ApiPropertyOptional({ example: 'Had discovery call, very interested.' })
  @IsString()
  @IsOptional()
  content?: string;

  @ApiPropertyOptional()
  @IsOptional()
  metadata?: Record<string, any>;
}
