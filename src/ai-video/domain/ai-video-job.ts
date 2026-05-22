import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * AI Video Job statuses — granular state machine.
 *
 * Happy path:
 *   CREATED → INGESTING → INGESTED → NORMALIZING → NORMALIZED
 *   → PROCESSING → PROCESSED → PENDING_REVIEW → APPROVED
 *   → SCHEDULED → PUBLISHING → PUBLISHED
 *
 * Error states (one per pipeline stage):
 *   INGEST_FAILED, NORMALIZE_FAILED, PROCESS_FAILED, PUBLISH_FAILED
 *
 * Governance states:
 *   REJECTED, CANCELLED, BLOCKED_BY_POLICY, BLOCKED_WAITING_APPROVAL
 */
export type AiVideoJobStatus =
  | 'CREATED'
  | 'INGESTING'
  | 'INGESTED'
  | 'NORMALIZING'
  | 'NORMALIZED'
  | 'PROCESSING'
  | 'PROCESSED'
  | 'PENDING_REVIEW'
  | 'APPROVED'
  | 'SCHEDULED'
  | 'PUBLISHING'
  | 'PUBLISHED'
  | 'REJECTED'
  | 'CANCELLED'
  // Granular error states
  | 'INGEST_FAILED'
  | 'NORMALIZE_FAILED'
  | 'PROCESS_FAILED'
  | 'PUBLISH_FAILED'
  // Governance blocks
  | 'BLOCKED_BY_POLICY'
  | 'BLOCKED_WAITING_APPROVAL';

export type AiVideoSourceType = 'manual_upload' | 'url_import' | 'script_production';

export class AiVideoJob {
  @ApiProperty()
  id: string;

  @ApiProperty()
  tenantId: string;

  @ApiProperty({ enum: ['manual_upload', 'url_import', 'script_production'] })
  sourceType: AiVideoSourceType;

  @ApiPropertyOptional()
  sourceUrl?: string;

  @ApiPropertyOptional()
  scriptText?: string;

  @ApiProperty()
  status: AiVideoJobStatus;

  @ApiPropertyOptional()
  recipeId?: string;

  @ApiPropertyOptional({ description: 'Target Facebook Page ID from connected channels' })
  facebookPageId?: string;

  @ApiPropertyOptional()
  caption?: string;

  @ApiProperty({ type: [String] })
  hashtags: string[];

  @ApiPropertyOptional()
  scheduledAt?: Date;

  @ApiPropertyOptional()
  publishedAt?: Date;

  @ApiPropertyOptional({ description: 'Platform-specific video ID returned after publishing' })
  platformVideoId?: string;

  @ApiPropertyOptional({ description: 'Platform-specific post ID' })
  platformPostId?: string;

  @ApiPropertyOptional()
  errorDetails?: string;

  @ApiPropertyOptional()
  rejectReason?: string;

  @ApiPropertyOptional()
  createdById?: string;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}
