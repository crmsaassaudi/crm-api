import { ApiProperty } from '@nestjs/swagger';

export enum SubscriptionPlan {
  FREE = 'FREE',
  PRO = 'PRO',
  ENTERPRISE = 'ENTERPRISE',
}

export enum TenantStatus {
  ACTIVE = 'ACTIVE',
  SUSPENDED = 'SUSPENDED',
}

export class Tenant {
  @ApiProperty({ type: String })
  id: string;

  @ApiProperty()
  keycloakOrgId: string;

  @ApiProperty()
  alias: string;

  @ApiProperty()
  name: string;

  @ApiProperty()
  owner: string;

  @ApiProperty({ enum: SubscriptionPlan })
  subscriptionPlan: SubscriptionPlan;

  @ApiProperty({ enum: TenantStatus })
  status: TenantStatus;

  @ApiProperty()
  omniSettings: {
    resolveNoteMode: 'disabled' | 'optional' | 'required';
  };

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}
