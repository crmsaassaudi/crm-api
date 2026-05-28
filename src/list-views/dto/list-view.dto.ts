import { ApiProperty, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsMongoId,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export class ListViewColumnDto {
  @ApiProperty()
  @IsString()
  @Length(1, 80)
  field: string;

  @ApiProperty({ required: false })
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

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  visible?: boolean;
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

  @ApiProperty({ required: false })
  @IsOptional()
  @IsObject()
  filters?: Record<string, unknown>;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsObject()
  sort?: Record<string, 'asc' | 'desc'>;

  @ApiProperty({ required: false, enum: ['private', 'shared', 'system'] })
  @IsOptional()
  @IsIn(['private', 'shared', 'system'])
  visibility?: 'private' | 'shared' | 'system';

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @ApiProperty({ required: false, type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsMongoId({ each: true })
  sharedWithUserIds?: string[];
}

export class UpdateListViewDto extends PartialType(CreateListViewDto) {}
