import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * NOT YET WIRED — nothing reads or writes AI-video assets (audit §43).
 *
 * This class and `AiVideoAssetSchemaClass` describe where a job's outputs (rendered
 * video, thumbnail, subtitles) are meant to live. As of this audit they are the only
 * entity in the module with a domain class and a schema but **no repository, no
 * mapper and no service reference** — job, settings and audit-log each have all
 * three. `AiVideoJobSchemaClass` has no output field either, so a completed job
 * currently has nowhere to record what it produced.
 *
 * Left in place deliberately rather than deleted: unlike the dead code this audit
 * removed elsewhere, there is no alternative implementation to fall back on — this
 * IS the design for the outputs half, and ai-video is an actively built module.
 * Deleting it would remove the design without replacing it.
 *
 * The cost of leaving it is not zero: the schema is registered in `ai-video.module.ts`,
 * so Mongoose maintains four indexes on a permanently empty `ai_video_assets`
 * collection in every environment. Finishing or removing the feature is an owner
 * decision, not a cleanup.
 */

export type AiVideoAssetType =
  | 'original'
  | 'normalized'
  | 'processed'
  | 'thumbnail'
  | 'subtitle';

export class AiVideoAsset {
  @ApiProperty()
  id: string;

  @ApiProperty()
  tenantId: string;

  @ApiProperty()
  jobId: string;

  @ApiProperty({
    enum: ['original', 'normalized', 'processed', 'thumbnail', 'subtitle'],
  })
  type: AiVideoAssetType;

  @ApiPropertyOptional()
  url?: string;

  @ApiPropertyOptional()
  storageKey?: string;

  @ApiPropertyOptional()
  duration?: number;

  @ApiPropertyOptional()
  size?: number;

  @ApiPropertyOptional()
  mimeType?: string;

  @ApiPropertyOptional()
  resolution?: string;

  @ApiPropertyOptional()
  checksum?: string;

  @ApiPropertyOptional()
  metadata?: Record<string, any>;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}
