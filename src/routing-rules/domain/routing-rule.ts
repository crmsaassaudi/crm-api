import { ApiProperty } from '@nestjs/swagger';

export class RoutingRule {
  @ApiProperty()
  id: string;

  @ApiProperty()
  tenantId: string;

  @ApiProperty({ example: 'Route VIP to Senior Team' })
  name: string;

  @ApiProperty({ example: 1 })
  priority: number;

  @ApiProperty({ enum: ['all', 'any'] })
  matchType: string;

  @ApiProperty()
  conditions: Array<{
    field: string;
    operator: string;
    value: string;
  }>;

  @ApiProperty()
  actions: {
    teamId: string;
    strategy: string;
    sticky: boolean;
    requiredSkills?: string[];
  };

  @ApiProperty()
  enabled: boolean;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}
