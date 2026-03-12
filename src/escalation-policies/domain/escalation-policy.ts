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

  @ApiProperty({ example: 80 })
  thresholdPercentage: number;

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
