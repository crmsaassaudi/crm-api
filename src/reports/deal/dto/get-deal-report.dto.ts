import { IsMongoId, IsOptional } from 'class-validator';
import { BaseReportFilterDto } from '../../shared/dto/base-report-filter.dto';

export class GetDealReportDto extends BaseReportFilterDto {
  @IsOptional()
  @IsMongoId()
  ownerId?: string;

  @IsOptional()
  @IsMongoId()
  stageId?: string;

  @IsOptional()
  @IsMongoId()
  sourceId?: string;

  /**
   * `pipelineId`, not `pipeline`. The filter used to match a free-text column
   * that no collection backed, so filtering a report by pipeline matched
   * whatever string the importer happened to write.
   */
  @IsOptional()
  @IsMongoId()
  pipelineId?: string;
}
