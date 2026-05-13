import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Channel Config domain entity.
 * Represents a tenant's configured sending account (SendGrid, Twilio, etc.)
 */
export class ChannelConfig {
  @ApiProperty()
  id: string;

  @ApiProperty()
  tenantId: string;

  @ApiProperty({ enum: ['sendgrid', 'smtp', 'twilio'] })
  providerType: string;

  @ApiProperty({ default: 1 })
  schemaVersion: number;

  @ApiProperty({ example: 'Production SendGrid' })
  name: string;

  @ApiProperty()
  isDefault: boolean;

  @ApiProperty({ enum: ['active', 'error', 'disabled'] })
  status: string;

  @ApiPropertyOptional()
  publicSettings: Record<string, any>;

  @ApiPropertyOptional({ enum: ['app_password', 'oauth2'] })
  authType: string;

  @ApiPropertyOptional()
  tokenExpiresAt: Date | null;

  @ApiPropertyOptional()
  deletedAt: Date | null;

  // ── Health Check Metadata (Phase 2) ─────────────────────────────────

  @ApiPropertyOptional()
  lastVerifiedAt: Date | null;

  @ApiPropertyOptional()
  lastHealthError: string | null;

  @ApiProperty({ default: 0 })
  consecutiveFailures: number;

  // ── Adaptive Health Check (Phase 3) ─────────────────────────────────

  @ApiPropertyOptional({ enum: ['healthy', 'degraded', 'unhealthy'] })
  healthState: string;

  @ApiPropertyOptional()
  nextHealthCheckAt: Date | null;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;

  /**
   * Encrypted credentials — NEVER returned in list/detail API responses.
   * Only used internally by the service layer for decryption.
   */
  encryptedCredentials?: string;

  /**
   * OAuth2 tokens are encrypted at rest and only selected for internal flows.
   */
  accessToken?: string | null;
  refreshToken?: string | null;
}
