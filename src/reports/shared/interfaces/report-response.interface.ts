export interface BaseReportMeta {
  generatedAt: string;
  totalRecords: number;
  executionMs: number;
  requestedGranularity?: string;
  resolvedGranularity?: string;
  warnings?: string[];
}

export interface ReportResponse<
  TData = unknown,
  TMeta extends BaseReportMeta = BaseReportMeta,
> {
  report: string;
  period: { from: string; to: string };
  filters: Record<string, unknown>;
  data: TData;
  meta: TMeta;
}

export interface FunnelReportMeta extends BaseReportMeta {
  stageHistoryCoverage: {
    totalContacts: number;
    contactsWithHistory: number;
    coveragePercent: number;
    reliableFrom: string | null;
  };
}
