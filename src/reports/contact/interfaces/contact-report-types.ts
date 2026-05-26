export interface GrowthDataPoint {
  date: string;
  createdCount: number;
  deletedCount: number;
  netGrowth: number;
}

export interface SourceAttributionItem {
  sourceId: string | null;
  sourceName: string;
  count: number;
  percentage: number;
}

export interface OmniActivationItem {
  channelType: string;
  count: number;
  percentage: number;
}

export interface ShadowConversionData {
  totalShadow: number;
  convertedCount: number;
  conversionRate: number;
  trend: Array<{ date: string; converted: number; total: number }>;
}

export interface FunnelVelocityItem {
  fromStage: string;
  fromStageName: string;
  toStage: string;
  toStageName: string;
  avgDays: number;
  medianDays: number;
  transitionCount: number;
}

export interface FunnelLeakageItem {
  type: 'backward' | 'skipped';
  fromStage: string;
  toStage: string;
  count: number;
  skippedStages?: string[];
}

export interface ScoreBucket {
  range: string;
  label: string;
  count: number;
  percentage: number;
}

export interface StaleContactsData {
  buckets: Array<{
    days: number;
    label: string;
    count: number;
    percentage: number;
  }>;
  totalStale: number;
  totalActive: number;
}

export interface OptOutData {
  emailOptOut: { count: number; total: number; rate: number };
  smsOptOut: { count: number; total: number; rate: number };
  doNotCall: { count: number; total: number; rate: number };
}

export interface AssignmentItem {
  ownerId: string | null;
  ownerName: string;
  count: number;
  percentage: number;
}
