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

export interface NotificationSoundConfig {
  /** Whether notification sound is enabled */
  enabled: boolean;
  /** URL to custom sound file. null = system default (synthesized chime) */
  soundUrl: string | null;
  /** Volume level 0-100. Default: 80 */
  volume: number;
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

  @ApiProperty({
    required: false,
    description: 'ID of the associated typebot workspace',
  })
  botWorkspaceId?: string;

  @ApiProperty()
  omniSettings: {
    resolveNoteMode: 'disabled' | 'optional' | 'required';
    notificationSound?: {
      agent: NotificationSoundConfig;
      visitor: NotificationSoundConfig;
    };
  };

  @ApiProperty({ description: 'Storage quota for tenant files' })
  storageQuota: {
    /** Maximum storage in bytes. -1 = unlimited */
    limitBytes: number;
    /** Currently used storage in bytes (atomic $inc) */
    usedBytes: number;
    /** Alert threshold percentage (default 80) */
    warnThresholdPercent: number;
    /** Last time usedBytes was recalculated by cron */
    lastRecalculatedAt?: Date;
  };

  @ApiProperty({
    description: 'Cached storage breakdown by category (daily cron)',
  })
  storageBreakdown?: {
    omni_media: { count: number; sizeBytes: number };
    ticket_attachment: { count: number; sizeBytes: number };
    general: { count: number; sizeBytes: number };
    lastCalculatedAt?: Date;
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
