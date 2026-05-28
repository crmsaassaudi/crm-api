import { PartialType } from '@nestjs/swagger';
import { CreateDealDto } from './create-deal.dto';
import { IsDateString, IsOptional, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateDealDto extends PartialType(CreateDealDto) {
  @ApiPropertyOptional({ example: 'Budget constraint' })
  @IsString()
  @IsOptional()
  lostReason?: string;

  @ApiPropertyOptional({ example: '2026-06-15T00:00:00Z' })
  @IsDateString()
  @IsOptional()
  wonAt?: string;

  @ApiPropertyOptional({ example: '2026-06-15T00:00:00Z' })
  @IsDateString()
  @IsOptional()
  lostAt?: string;
}
