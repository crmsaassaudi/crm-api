import { ApiProperty } from '@nestjs/swagger';

export class EscalationPolicy {
  @ApiProperty()
  id: string;

  @ApiProperty()
  tenant: string;

  @ApiProperty({ example: 'Critical SLA Breach' })
  name: string;

  @ApiProperty({ example: '507f1f77bcf86cd799439011' })
  slaId: string;

  @ApiProperty({ enum: ['warning', 'breach'] })
  breachType: string;

  @ApiProperty({
    example: 5,
    description: 'Time after SLA breach before escalation triggers',
  })
  escalateAfter: number;

  @ApiProperty({ enum: ['minutes', 'hours'], example: 'minutes' })
  escalateUnit: string;

  @ApiProperty()
  actions: Array<{
    type: string;
    value: string;
  }>;

  @ApiProperty()
  enabled: boolean;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}
