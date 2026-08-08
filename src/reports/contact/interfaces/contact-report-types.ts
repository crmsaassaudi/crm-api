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

export interface LeadConversionData {
  /** False when the tenant has not marked any `contact_lifecycle` stage as a lead — the rate below is not meaningful without one. */
  configured: boolean;
  leadStageNames: string[];
  totalLeads: number;
  wonCount: number;
  conversionRate: number;
  trend: Array<{ date: string; won: number; total: number }>;
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
  whatsappOptOut?: { count: number; total: number; rate: number };
  doNotCall: { count: number; total: number; rate: number };
}

export interface AssignmentItem {
  ownerId: string | null;
  ownerName: string;
  count: number;
  percentage: number;
}

/**
 * How complete the customer records are.
 *
 * The audit's "data quality dashboard": which contacts cannot be emailed, called
 * or attributed, and who owns the gap. Reported as a rate rather than a raw
 * count so a growing database does not look like a worsening one.
 */
export interface DataQualityField {
  field: string;
  missing: number;
  total: number;
  /** Percentage of records missing this field. */
  rate: number;
}

export interface DataQualityData {
  total: number;
  fields: DataQualityField[];
  /** Contacts reachable by neither email nor phone — dead records. */
  unreachable: number;
  /** Contacts with no owner: invisible to every scoped user by design. */
  unowned: number;
  /** Contacts still carrying a duplicate-looking identity-less shadow profile. */
  shadow: number;
}
