import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
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
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { FIELD_TYPES, FieldType } from '../field-type';
import {
  CONFIGURABLE_OBJECTS,
  ConfigurableObject,
} from '../../object-manager/object-registry';

/**
 * The DTOs the custom-field endpoints never had.
 *
 * `POST /custom-fields` and `PATCH /custom-fields/:id` took `@Body() body:
 * Omit<CustomField, …>` and `Partial<CustomField>` — TypeScript shapes, which are
 * erased at runtime, so the global `ValidationPipe` had nothing to validate
 * against. In practice that meant:
 *
 *   - `fieldType` was any string. An unrecognised one reached
 *     `CustomFieldValueValidator.coerce`, hit its `default:` branch, and every
 *     value for that field was stored unvalidated with only a log line to say so.
 *   - `module` was any string, so a field could be created for an object that does
 *     not exist and would never be read by anything.
 *   - `internalKey` was unconstrained: it could collide with a standard payload key
 *     (`ownerId`, `emails`), contain a `.` and become a nested path in the Mixed
 *     column, or be `__proto__`.
 *   - `PATCH` could change `internalKey` or `module`, orphaning every value already
 *     stored under the old key — and defeating the soft-delete that exists
 *     precisely so a retired key cannot be reused.
 */

export class CustomFieldOptionDto {
  @ApiProperty({ maxLength: 200 })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  label: string;

  @ApiProperty({ maxLength: 200 })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  value: string;
}

export class CreateCustomFieldDto {
  @ApiProperty({ enum: CONFIGURABLE_OBJECTS })
  @IsIn(CONFIGURABLE_OBJECTS as readonly string[])
  module: ConfigurableObject;

  // The pattern allows letters, digits and underscore, starting with a letter. It
  // excludes `.` (which would create a nested path inside the Mixed column), `$` (a
  // Mongo operator prefix), and anything that could collide with a prototype
  // property.
  @ApiProperty({
    description:
      'Stable key for the value inside the record’s `customFields`. Immutable once created.',
    example: 'preferred_channel',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  @Matches(/^[a-z][a-z0-9_]*$/i, {
    message:
      'internalKey must start with a letter and contain only letters, digits and underscores',
  })
  internalKey: string;

  @ApiProperty({ maxLength: 200 })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  displayLabel: string;

  @ApiProperty({ enum: FIELD_TYPES })
  @IsIn(FIELD_TYPES as readonly string[])
  fieldType: FieldType;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

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
  orderIndex?: number;

  @ApiPropertyOptional({
    description:
      'Constraints applied by CustomFieldValueValidator: isRequired, minLength, maxLength.',
  })
  @IsOptional()
  @IsObject()
  validation?: Record<string, unknown>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  governance?: Record<string, unknown>;

  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  objectView?: string;

  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  placeholder?: string;

  @ApiPropertyOptional({ type: [CustomFieldOptionDto], maxItems: 500 })
  @IsOptional()
  @IsArray()
  // Bounded because the option set is embedded in the field document and shipped
  // to every client in the object config. An unbounded picklist is a payload
  // problem long before it is a usability one.
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => CustomFieldOptionDto)
  options?: CustomFieldOptionDto[];
}

/**
 * The mutable subset: everything except `internalKey`, `module` and `fieldType`.
 *
 * Those three are the field's identity and the contract for every value already
 * stored under it. Changing `internalKey` or `module` orphans that data; changing
 * `fieldType` reinterprets it. Retiring the field (`isActive: false`) and creating
 * a new one is the operation that does not silently rewrite history — and the
 * unique index deliberately still covers retired rows, so the old key cannot come
 * back attached to different data.
 *
 * Spelled out rather than derived from `CreateCustomFieldDto` with `PartialType` +
 * `OmitType`: the immutability of those three fields is the point of this class,
 * and a reader should be able to see which fields survive without knowing how
 * Nest's mapped types compose.
 */
export class UpdateCustomFieldDto {
  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  displayLabel?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

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
  orderIndex?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  validation?: Record<string, unknown>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  governance?: Record<string, unknown>;

  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  objectView?: string;

  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  placeholder?: string;

  @ApiPropertyOptional({ type: [CustomFieldOptionDto], maxItems: 500 })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => CustomFieldOptionDto)
  options?: CustomFieldOptionDto[];
}
