import { Body, Controller, Param, Put } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiPropertyOptional,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import { RequirePermission } from '../../common/permissions';
import { CONFIGURABLE_OBJECTS, ConfigurableObject } from '../object-registry';
import { ObjectRegistryService } from '../object-registry.service';
import { ACCESS_LEVELS, MASKING_STRATEGIES } from './field-policy';
import { LayoutAdminService } from './layout-admin.service';

class LayoutFieldDto {
  @ApiProperty({ description: 'Payload key, column key or a legacy alias.' })
  @IsString()
  @MaxLength(120)
  key: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isVisible?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isRequired?: boolean;

  @ApiPropertyOptional({ enum: ACCESS_LEVELS })
  @IsOptional()
  @IsIn(ACCESS_LEVELS as readonly string[])
  accessLevel?: (typeof ACCESS_LEVELS)[number];

  @ApiPropertyOptional({ enum: MASKING_STRATEGIES })
  @IsOptional()
  @IsIn(MASKING_STRATEGIES as readonly string[])
  masking?: (typeof MASKING_STRATEGIES)[number];

  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  section?: string;

  @ApiPropertyOptional({ minimum: 0, maximum: 10_000 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000)
  sortOrder?: number;

  @ApiPropertyOptional({ type: [String], maxItems: 100 })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  visibleAtStages?: string[];
}

class ReplaceLayoutDto {
  @ApiProperty({ type: [LayoutFieldDto], maxItems: 500 })
  @IsArray()
  // One entry per configurable field. 500 is well past the standard catalog plus
  // the 300-field custom cap, and bounds the document a single request can write.
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => LayoutFieldDto)
  fields: LayoutFieldDto[];
}

class ReplaceSectionsDto {
  @ApiProperty()
  @IsObject()
  sections: Record<string, unknown>;
}

/**
 * Scoped writes for the Object Manager layout screen.
 *
 * Replaces `PATCH /crm-settings/layout_settings`, which took the whole document
 * from a snapshot the browser loaded at mount: two administrators editing different
 * objects, or different groups, silently overwrote each other. Each route here
 * writes exactly the array it names.
 */
@ApiTags('Object Manager')
@ApiBearerAuth()
@Controller({ path: 'object-manager/layouts', version: '1' })
export class LayoutAdminController {
  constructor(
    private readonly layouts: LayoutAdminService,
    private readonly registry: ObjectRegistryService,
  ) {}

  @Put(':groupId/:object')
  @RequirePermission('manage_system', 'settings')
  @ApiOperation({
    summary: 'Replace one object’s field configuration for one group.',
    description:
      'Writes a single path inside `layout_settings`, so a concurrent edit to another object or group cannot be lost. Entries are stored under the payload key; legacy and column keys are accepted and resolved.',
  })
  replaceObjectLayout(
    @Param('groupId') groupId: string,
    @Param('object') object: string,
    @Body() body: ReplaceLayoutDto,
  ) {
    const configurable: ConfigurableObject = this.registry.assertObject(object);
    return this.layouts.replaceObjectLayout(groupId, configurable, body.fields);
  }

  @Put('sections')
  @RequirePermission('manage_system', 'settings')
  @ApiOperation({
    summary: 'Replace the shared section configuration.',
    description: `Applies across ${CONFIGURABLE_OBJECTS.join(', ')} and touches no group layout.`,
  })
  async replaceSections(@Body() body: ReplaceSectionsDto) {
    await this.layouts.replaceSections(body.sections);
    return { success: true };
  }
}
