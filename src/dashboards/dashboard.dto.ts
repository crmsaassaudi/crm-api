import {
  IsString,
  IsOptional,
  IsBoolean,
  IsArray,
  ValidateNested,
  IsNumber,
  MaxLength,
  Min,
  Max,
} from 'class-validator';
import { Type } from 'class-transformer';
import { PartialType } from '@nestjs/mapped-types';

export class DashboardWidgetDto {
  @IsString() id: string;
  @IsString() type: string;
  @IsNumber() @Min(0) @Max(11) x: number;
  @IsNumber() @Min(0) y: number;
  @IsNumber() @Min(1) @Max(12) w: number;
  @IsNumber() @Min(1) h: number;
  @IsOptional() config?: Record<string, any>;
}

export class CreateDashboardDto {
  @IsString() @MaxLength(100) name: string;
  @IsOptional() @IsString() @MaxLength(300) description?: string;
  @IsOptional() @IsBoolean() isShared?: boolean;
  @IsOptional() @IsString() icon?: string;
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DashboardWidgetDto)
  widgets?: DashboardWidgetDto[];
}

export class UpdateDashboardDto extends PartialType(CreateDashboardDto) {}
