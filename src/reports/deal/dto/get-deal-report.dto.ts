import { IsOptional, IsString } from 'class-validator';
import { BaseReportFilterDto } from '../../shared/dto/base-report-filter.dto';

export class GetDealReportDto extends BaseReportFilterDto {
  @IsOptional()
  @IsString()
  ownerId?: string;

  @IsOptional()
  @IsString()
  stageId?: string;

  @IsOptional()
  @IsString()
  sourceId?: string;

  @IsOptional()
  @IsString()
  pipeline?: string;
}
