import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
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
import { FilterGroupDto } from '../../filters/dto/filter-group.dto';
import { SEGMENT_TYPES, SegmentType } from '../contact-segment.schema';

export class CreateContactSegmentDto {
  @ApiProperty({ example: 'Riyadh VIPs, quiet 90 days' })
  @IsString()
  @Length(1, 120)
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(0, 500)
  description?: string;

  @ApiProperty({ enum: SEGMENT_TYPES as unknown as string[] })
  @IsIn(SEGMENT_TYPES as unknown as string[])
  type: SegmentType;

  @ApiPropertyOptional({ type: FilterGroupDto })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => FilterGroupDto)
  filter?: FilterGroupDto;

  /**
   * Static membership. Capped: a static segment is an audience someone curated,
   * not a bulk import — past this size the answer is a dynamic segment.
   */
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10_000)
  @IsMongoId({ each: true })
  memberIds?: string[];
}

export class UpdateContactSegmentDto extends PartialType(
  CreateContactSegmentDto,
) {}

export class PreviewContactSegmentDto {
  @ApiProperty({ type: FilterGroupDto })
  @IsObject()
  @ValidateNested()
  @Type(() => FilterGroupDto)
  filter: FilterGroupDto;

  @ApiPropertyOptional({ default: 5 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(25)
  @Type(() => Number)
  sampleSize?: number;
}

export class ContactSegmentMembersDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  page?: number;

  @ApiPropertyOptional({ default: 25 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  @Type(() => Number)
  limit?: number;
}
