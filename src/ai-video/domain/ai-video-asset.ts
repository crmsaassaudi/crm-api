import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

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
