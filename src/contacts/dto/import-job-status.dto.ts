import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ImportSummaryDto {
  @ApiProperty() total: number;
  @ApiProperty() inserted: number;
  @ApiProperty() updated: number;
  @ApiProperty() skipped: number;
  @ApiProperty() errors: number;
}

export class DryRunPreviewDto {
  @ApiProperty() wouldInsert: number;
  @ApiProperty() wouldUpdate: number;
  @ApiProperty() wouldSkip: number;
  @ApiProperty() validationErrors: number;
}

export class ImportJobResultDto {
  @ApiProperty() jobId: string;
  @ApiProperty() dryRun: boolean;
  @ApiPropertyOptional({ type: ImportSummaryDto })
  summary?: ImportSummaryDto;
  @ApiPropertyOptional({ type: DryRunPreviewDto })
  preview?: DryRunPreviewDto;
  @ApiPropertyOptional() reportUrl?: string;
}

export class ImportJobStatusDto {
  @ApiProperty({
    description: 'BullMQ job state',
    example: 'active',
    enum: ['waiting', 'active', 'completed', 'failed', 'delayed', 'paused'],
  })
  status: string;

  @ApiProperty({ description: 'Progress percent (0-100)', example: 45 })
  progress: unknown;

  @ApiPropertyOptional({ type: ImportJobResultDto })
  result?: ImportJobResultDto;

  @ApiPropertyOptional()
  failedReason?: string;
}
