import { IsIn, IsOptional, IsString } from 'class-validator';
import { BaseReportFilterDto } from '../../shared/dto/base-report-filter.dto';

export class GetTicketReportDto extends BaseReportFilterDto {
  @IsOptional()
  @IsString()
  ownerId?: string;

  @IsOptional()
  @IsString()
  statusId?: string;

  @IsOptional()
  @IsString()
  typeId?: string;

  @IsOptional()
  @IsIn(['URGENT', 'HIGH', 'MEDIUM', 'LOW'])
  priority?: string;

  @IsOptional()
  @IsString()
  groupId?: string;
}
