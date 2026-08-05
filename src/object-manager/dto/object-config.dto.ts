import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CONFIGURABLE_OBJECTS, ConfigurableObject } from '../object-registry';
import { ACCESS_LEVELS, MASKING_STRATEGIES } from '../layout/field-policy';

export class ObjectFieldDto {
  @ApiProperty({
    description:
      'The property name in the record payload. The identity of the field for validation, masking and field-level security.',
    example: 'ownerId',
  })
  key: string;

  @ApiProperty({
    description:
      'The identity of the rendered column. Equals `key` unless the column shows a populated relation (`owner` renders from `ownerId`).',
    example: 'owner',
  })
  column: string;

  @ApiProperty({
    description:
      'i18n token, resolved client-side. Never a human-readable string — the API has no display locale.',
    example: 'owner',
  })
  labelToken: string;

  @ApiProperty({ example: 'USER_REFERENCE' })
  type: string;

  @ApiProperty({ example: 'assignment' })
  category: string;

  @ApiProperty({
    description:
      'Server-owned. A client value is discarded, and it cannot be required.',
  })
  readOnly: boolean;

  @ApiProperty({
    description: 'Audit metadata. Never configurable in a layout.',
  })
  audit: boolean;

  @ApiProperty({
    description:
      'Whether a masking strategy on this field would take effect. False for non-string values and for primary labels.',
  })
  maskable: boolean;

  @ApiProperty({ description: 'Whether the field may be marked required.' })
  requirable: boolean;

  @ApiProperty({ description: 'False for fields defined by the tenant.' })
  isStandard: boolean;

  @ApiPropertyOptional({
    description:
      'Allowed values, for custom fields declaring a fixed option set.',
  })
  options?: { label: string; value: string }[];
}

export class ObjectDescriptorDto {
  @ApiProperty({ enum: CONFIGURABLE_OBJECTS })
  name: ConfigurableObject;

  @ApiProperty({
    type: [ObjectFieldDto],
    description:
      'Standard fields first, in declaration order, then the tenant’s active custom fields.',
  })
  fields: ObjectFieldDto[];
}

export class FieldPolicyDto {
  @ApiProperty({
    type: [String],
    description:
      'Payload keys stripped from responses and refused on write for this caller.',
  })
  hidden: string[];

  @ApiProperty({
    type: [String],
    description: 'Payload keys the caller may read but not write.',
  })
  readOnly: string[];

  @ApiProperty({
    description: 'Payload key → masking strategy applied to responses.',
    example: { phones: 'last_4' },
  })
  masking: Record<string, string>;

  @ApiProperty({
    type: [String],
    description:
      'Payload keys this caller must supply on create. Never contains a read-only or hidden field.',
  })
  required: string[];
}

export class ObjectConfigDto {
  @ApiProperty({ type: [ObjectDescriptorDto] })
  objects: ObjectDescriptorDto[];

  @ApiProperty({
    description:
      'Per-object effective field policy for the authenticated caller, resolved from their group layouts.',
    additionalProperties: { $ref: '#/components/schemas/FieldPolicyDto' },
  })
  policies: Partial<Record<ConfigurableObject, FieldPolicyDto>>;

  @ApiProperty({ enum: ACCESS_LEVELS, isArray: true })
  accessLevels: readonly string[];

  @ApiProperty({ enum: MASKING_STRATEGIES, isArray: true })
  maskingStrategies: readonly string[];
}
