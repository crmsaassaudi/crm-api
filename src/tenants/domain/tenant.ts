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

export enum ProvisioningStatus {
  QUEUED = 'QUEUED',
  PROVISIONING = 'PROVISIONING',
  READY = 'READY',
  FAILED = 'FAILED',
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

  @ApiProperty({
    enum: ProvisioningStatus,
    description: 'Async provisioning lifecycle state',
  })
  provisioningStatus: ProvisioningStatus;

  @ApiProperty({
    required: false,
    description: 'Error message when provisioningStatus is FAILED',
  })
  provisioningError?: string;

  @ApiProperty({
    required: false,
    description: 'User-selected onboarding use case (PLG)',
  })
  onboardingGoal?: string;

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

  @ApiProperty({
    required: false,
    type: [String],
    nullable: true,
    description:
      'Explicit list of FEATURE permission keys granted to this tenant on top ' +
      'of the CORE_PERMISSIONS baseline. Null = Core permissions only (default).',
    example: ['contacts:import', 'campaigns:view'],
  })
  availablePermissions: string[] | null;

  @ApiProperty({
    required: false,
    type: [String],
    description:
      'Core permission keys explicitly disabled for this tenant. Empty means full Core baseline.',
    example: ['tasks:delete'],
  })
  disabledCorePermissions: string[];

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}
