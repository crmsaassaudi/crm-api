import { PartialType } from '@nestjs/swagger';
import { CreateDealDto } from './create-deal.dto';
import { IsDate, IsOptional, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';

export class UpdateDealDto extends PartialType(CreateDealDto) {
  @ApiPropertyOptional({ example: 'Budget constraint' })
  @IsString()
  @IsOptional()
  lostReason?: string;

  @ApiPropertyOptional({ example: '2026-06-15T00:00:00Z' })
  @IsDate()
  @Type(() => Date)
  @IsOptional()
  wonAt?: Date;

  @ApiPropertyOptional({ example: '2026-06-15T00:00:00Z' })
  @IsDate()
  @Type(() => Date)
  @IsOptional()
  lostAt?: Date;
}
