import { BaseReportFilterDto } from '../dto/base-report-filter.dto';
import {
  BaseReportMeta,
  ReportResponse,
} from '../interfaces/report-response.interface';

interface BuildReportResponseParams<TData, TMeta extends BaseReportMeta> {
  report: string;
  dto: BaseReportFilterDto;
  data: TData;
  totalRecords: number;
  startedAt: bigint;
  requestedGranularity?: string;
  resolvedGranularity?: string;
  warnings?: string[];
  meta?: Partial<TMeta>;
}

export const buildReportResponse = <
  TData,
  TMeta extends BaseReportMeta = BaseReportMeta,
>({
  report,
  dto,
  data,
  totalRecords,
  startedAt,
  requestedGranularity,
  resolvedGranularity,
  warnings,
  meta,
}: BuildReportResponseParams<TData, TMeta>): ReportResponse<TData, TMeta> => {
  const executionMs = Math.round(
    Number(process.hrtime.bigint() - startedAt) / 1_000_000,
  );

  return {
    report,
    period: {
      from: dto.fromDate,
      to: dto.toDate,
    },
    filters: serializeFilters(dto),
    data,
    meta: {
      generatedAt: new Date().toISOString(),
      totalRecords,
      executionMs,
      requestedGranularity,
      resolvedGranularity,
      warnings: warnings?.filter(Boolean) ?? [],
      ...(meta ?? {}),
    } as TMeta,
  };
};

const serializeFilters = (dto: BaseReportFilterDto): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(dto).filter(([, value]) => value !== undefined),
  );
