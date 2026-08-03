export interface PipelineSummaryItem {
  stageId: string | null;
  stageName: string;
  stageColor: string;
  dealCount: number;
  totalValue: number;
  avgValue: number;
  avgProbability: number;
  weightedValue: number;
}

export interface RevenueTrendPoint {
  date: string;
  wonCount: number;
  lostCount: number;
  wonValue: number;
  lostValue: number;
}

// Win/Loss Rate
export interface WinLossSummary {
  won: number;
  lost: number;
  open: number;
  winRate: number;
  totalValue: number;
  wonValue: number;
}

export interface WinLossByStage {
  stageId: string | null;
  stageName: string;
  won: number;
  lost: number;
  winRate: number;
}

export interface WinLossBySource {
  sourceId: string | null;
  sourceName: string;
  won: number;
  lost: number;
  winRate: number;
}

export interface WinLossRateData {
  overall: WinLossSummary;
  byStage: WinLossByStage[];
  bySource: WinLossBySource[];
}

export interface DealAgingBucket {
  bucket: string;
  label: string;
  minDays: number;
  maxDays: number | null;
  count: number;
  totalValue: number;
  percentage: number;
}

export interface OwnerPerformanceItem {
  ownerId: string | null;
  ownerName: string;
  ownerEmail: string;
  totalDeals: number;
  wonDeals: number;
  lostDeals: number;
  openDeals: number;
  winRate: number;
  totalWonValue: number;
  avgDealSize: number;
}

export interface DealVelocityData {
  avgDaysToClose: number;
  medianDaysToClose: number;
  totalWonDeals: number;
  avgDealValue: number;
}
