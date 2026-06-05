import { ApiProperty, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export class ListViewColumnDto {
  @ApiProperty({ description: 'Field key matching the column registry' })
  @IsString()
  @Length(1, 80)
  key: string;

  @ApiProperty({ required: false, description: 'Display label (optional fallback — frontend resolves via i18n)' })
  @IsOptional()
  @IsString()
  @Length(1, 120)
  label?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  @Min(50)
  @Max(2_000)
  width?: number;

  @ApiProperty({ description: 'Whether this column is visible in the table' })
  @IsBoolean()
  isVisible: boolean;

  @ApiProperty({ description: 'Display order (1-based)' })
  @IsInt()
  @Min(1)
  @Max(200)
  sortOrder: number;
}

export class CreateListViewDto {
  @ApiProperty()
  @IsString()
  @Length(1, 120)
  name: string;

  @ApiProperty({ description: 'CRM module this view belongs to' })
  @IsString()
  @Length(1, 60)
  module: string;

  @ApiProperty({ type: [ListViewColumnDto], required: false })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ListViewColumnDto)
  columns?: ListViewColumnDto[];

  @ApiProperty({ required: false, description: 'Group IDs this view is assigned to' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  assignedGroupIds?: string[];

  @ApiProperty({ required: false, description: 'User IDs excluded from this view' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  excludedUserIds?: string[];
}

export class UpdateListViewDto extends PartialType(CreateListViewDto) {}
