import { ApiProperty } from '@nestjs/swagger';

export class AutomationRule {
  @ApiProperty()
  id: string;

  @ApiProperty()
  tenant: string;

  @ApiProperty({ example: 'Auto-assign new tickets' })
  name: string;

  @ApiProperty()
  trigger: {
    event: string;
    matchType: string;
    conditions: Array<{
      field: string;
      operator: string;
      value: string;
    }>;
  };

  @ApiProperty()
  actions: Array<{
    type: string;
    value: string;
  }>;

  @ApiProperty()
  enabled: boolean;

  @ApiProperty()
  executionCount: number;

  @ApiProperty({ nullable: true })
  lastExecutedAt: Date | null;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}
