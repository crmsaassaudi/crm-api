import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * AI Video Job statuses.
 *
 * Happy path:
 *   CREATED -> INGESTING -> INGESTED -> NORMALIZING -> NORMALIZED
 *   -> PROCESSING -> PROCESSED -> PENDING_REVIEW -> APPROVED
 *
 * AI Video is the user's video library. Publishing and scheduling are owned by
 * the social-posts module.
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
  | 'REJECTED'
  | 'CANCELLED'
  | 'INGEST_FAILED'
  | 'NORMALIZE_FAILED'
  | 'PROCESS_FAILED';

export type AiVideoSourceType = 'url_import' | 'script_production';

export class AiVideoJob {
  @ApiProperty()
  id: string;

  @ApiProperty()
  tenantId: string;

  @ApiProperty({ enum: ['url_import', 'script_production'] })
  sourceType: AiVideoSourceType;

  @ApiPropertyOptional()
  sourceUrl?: string;

  @ApiPropertyOptional()
  scriptText?: string;

  @ApiProperty()
  status: AiVideoJobStatus;

  @ApiPropertyOptional()
  recipeId?: string;

  @ApiPropertyOptional()
  caption?: string;

  @ApiProperty({ type: [String] })
  hashtags: string[];

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
