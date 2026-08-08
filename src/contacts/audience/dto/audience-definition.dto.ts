import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsMongoId,
  IsObject,
  IsOptional,
  ValidateNested,
} from 'class-validator';
import { FilterGroupDto } from '../../filters/dto/filter-group.dto';
import {
  AUDIENCE_SOURCE_TYPES,
  AudienceSource,
  AudienceSourceType,
  MAX_AUDIENCE_SOURCES,
} from '../audience-definition';

/**
 * One source: a saved segment, or a condition tree written in place.
 *
 * The pairing of `type` with the field it requires is checked by
 * `assertAudienceShape`, so the rule lives with the model instead of once here
 * and once again wherever an audience is built.
 */
export class AudienceSourceDto implements AudienceSource {
  @ApiProperty({ enum: AUDIENCE_SOURCE_TYPES as unknown as string[] })
  @IsIn(AUDIENCE_SOURCE_TYPES as unknown as string[])
  type: AudienceSourceType;

  @ApiPropertyOptional({ description: 'Required when type is "segment".' })
  @IsOptional()
  @IsMongoId()
  segmentId?: string;

  @ApiPropertyOptional({
    type: FilterGroupDto,
    description: 'Required when type is "filter".',
  })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => FilterGroupDto)
  filter?: FilterGroupDto;
}

export class AudienceDefinitionDto {
  @ApiProperty({
    type: [AudienceSourceDto],
    description: 'Unioned — a contact matching any of these is in the audience.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_AUDIENCE_SOURCES)
  @ValidateNested({ each: true })
  @Type(() => AudienceSourceDto)
  include: AudienceSourceDto[];

  @ApiPropertyOptional({
    type: [AudienceSourceDto],
    description: 'Subtracted — a contact matching any of these is left out.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_AUDIENCE_SOURCES)
  @ValidateNested({ each: true })
  @Type(() => AudienceSourceDto)
  exclude?: AudienceSourceDto[];
}
