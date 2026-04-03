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
  ownerId: string;

  @ApiProperty({ enum: SubscriptionPlan })
  subscriptionPlan: SubscriptionPlan;

  @ApiProperty({ enum: TenantStatus })
  status: TenantStatus;

  @ApiProperty()
  omniSettings: {
    resolveNoteMode: 'disabled' | 'optional' | 'required';
  };

  @ApiProperty({ description: 'Storage quota for media files (MB)' })
  storageQuota: {
    /** Maximum storage in MB. -1 = unlimited */
    limitMB: number;
    /** Currently used storage in MB */
    usedMB: number;
  };

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}
