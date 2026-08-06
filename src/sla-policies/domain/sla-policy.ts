import { ApiProperty } from '@nestjs/swagger';

export class SlaPolicy {
  @ApiProperty()
  id: string;

  @ApiProperty()
  tenantId: string;

  @ApiProperty({ example: 'Standard Response SLA' })
  name: string;

  @ApiProperty({ enum: ['conversation', 'ticket'] })
  appliesTo: 'conversation' | 'ticket';

  @ApiProperty({ enum: ['first_response', 'resolution', 'next_response'] })
  type: string;

  @ApiProperty({
    description:
      'Per-segment targets. On a ticket policy `segment` is the priority; null is the catch-all.',
  })
  targets: Array<{
    segment: string | null;
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
