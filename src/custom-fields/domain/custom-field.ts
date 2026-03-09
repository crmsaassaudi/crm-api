import { ApiProperty } from '@nestjs/swagger';

export class CustomField {
  @ApiProperty()
  id: string;

  @ApiProperty()
  tenant: string;

  @ApiProperty()
  module: string;

  @ApiProperty()
  internalKey: string;

  @ApiProperty()
  displayLabel: string;

  @ApiProperty()
  fieldType: string;

  @ApiProperty()
  isActive: boolean;

  @ApiProperty()
  section: string;

  @ApiProperty()
  orderIndex: number;

  @ApiProperty({ required: false })
  validation?: Record<string, any>;

  @ApiProperty({ required: false })
  governance?: Record<string, any>;

  @ApiProperty({ required: false })
  objectView?: string;

  @ApiProperty({ required: false })
  options?: { label: string; value: string }[];

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}
