import { ApiProperty, PartialType } from '@nestjs/swagger';
import {
  IsBoolean,
  IsHexColor,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';

class BaseSettingDto {
  @ApiProperty()
  @IsString()
  @Length(1, 80)
  name: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @Length(1, 80)
  apiName?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsHexColor()
  color?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  sortOrder?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @Length(0, 500)
  description?: string;
}

export class CreateTaskStatusDto extends BaseSettingDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  isTerminal?: boolean;
}

export class UpdateTaskStatusDto extends PartialType(CreateTaskStatusDto) {}

export class CreateTaskCategoryDto extends BaseSettingDto {}
export class UpdateTaskCategoryDto extends PartialType(CreateTaskCategoryDto) {}

export class CreateTaskSourceDto extends BaseSettingDto {}
export class UpdateTaskSourceDto extends PartialType(CreateTaskSourceDto) {}
