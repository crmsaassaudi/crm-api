import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
} from 'class-validator';

export type ReportGranularity = 'day' | 'week' | 'month';

export class BaseReportFilterDto {
  @IsDateString()
  fromDate: string;

  @IsDateString()
  toDate: string;

  @IsOptional()
  @IsIn(['day', 'week', 'month'])
  granularity?: ReportGranularity;

  @IsOptional()
  @IsString()
  timezone?: string;

  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  includeDeleted?: boolean;

  static resolveGranularity(
    from: Date,
    to: Date,
    requested?: string,
  ): ReportGranularity {
    const diffDays = Math.ceil((to.getTime() - from.getTime()) / 86_400_000);
    if (diffDays > 365) return 'month';
    if (diffDays > 90) return requested === 'month' ? 'month' : 'week';
    return (requested as ReportGranularity) || 'day';
  }
}
