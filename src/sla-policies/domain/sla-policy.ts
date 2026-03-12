import { ApiProperty } from '@nestjs/swagger';

export class SlaPolicy {
  @ApiProperty()
  id: string;

  @ApiProperty()
  tenant: string;

  @ApiProperty({ example: 'Standard Response SLA' })
  name: string;

  @ApiProperty({ enum: ['first_response', 'resolution', 'next_response'] })
  type: string;

  @ApiProperty()
  targets: Array<{
    segment: string;
    timeValue: number;
    timeUnit: string;
  }>;

  @ApiProperty()
  enabled: boolean;

  @ApiProperty()
  priority: number;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}
