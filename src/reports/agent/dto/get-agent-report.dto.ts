import { IsOptional, IsString } from 'class-validator';
import { BaseReportFilterDto } from '../../shared/dto/base-report-filter.dto';

export class GetAgentReportDto extends BaseReportFilterDto {
  /** Restrict to a single agent. */
  @IsOptional()
  @IsString()
  agentId?: string;

  /** Reserved: restrict to a team/group (resolved to members). Phase 5+. */
  @IsOptional()
  @IsString()
  groupId?: string;
}
