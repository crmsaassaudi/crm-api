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

  @ApiProperty({ required: false })
  logoUrl?: string;

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

  @ApiProperty({ description: 'Tenant-level i18n defaults' })
  i18nSettings: {
    /** BCP-47 locale: 'en', 'vi', 'fr', 'es', 'zh', 'ar', 'hi', 'uk' */
    locale: string;
    /** IANA timezone: 'UTC', 'Asia/Ho_Chi_Minh', 'America/New_York' */
    timezone: string;
    /** Date display format: 'DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD' */
    dateFormat: string;
    /** ISO 4217 currency code: 'USD', 'VND', 'EUR' */
    currency: string;
  };

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}
