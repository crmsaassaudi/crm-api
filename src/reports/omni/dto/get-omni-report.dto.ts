import { IsIn, IsMongoId, IsOptional } from 'class-validator';
import { BaseReportFilterDto } from '../../shared/dto/base-report-filter.dto';

const CHANNEL_TYPES = [
  'facebook',
  'zalo',
  'whatsapp',
  'livechat',
  'instagram',
  'tiktok',
  'email',
] as const;

export class GetOmniReportDto extends BaseReportFilterDto {
  @IsOptional()
  @IsIn(CHANNEL_TYPES)
  channelType?: string;

  @IsOptional()
  @IsMongoId()
  agentId?: string;
}
