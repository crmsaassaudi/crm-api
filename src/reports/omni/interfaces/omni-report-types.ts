// Phase 1 Reports

export interface ConversationVolumePoint {
  date: string;
  createdCount: number;
  resolvedCount: number;
  netActive: number;
}

export interface ChannelDistributionItem {
  channelType: string;
  count: number;
  percentage: number;
}

export interface AgentPerformanceItem {
  agentId: string | null;
  agentName: string;
  agentEmail: string;
  totalConversations: number;
  avgResolutionMs: number;
  avgResolutionFormatted: string;
  /** Mean time from the customer's first message to this agent's first reply. */
  avgFirstResponseMs: number | null;
  avgFirstResponseFormatted: string;
  slaBreachCount: number;
  slaBreachRate: number;
  avgMessageCount: number;
}

/**
 * A duration distribution. The mean alone hides the tail that customers
 * actually complain about, so p50 and p90 travel with it.
 */
export interface DurationStats {
  count: number;
  avgMs: number | null;
  p50Ms: number | null;
  p90Ms: number | null;
  avgFormatted: string;
  p50Formatted: string;
  p90Formatted: string;
}

export interface ResponseTimeData {
  totalConversations: number;
  /** Customer's first message → agent's first reply. The headline metric. */
  firstResponse: DurationStats;
  /** Time a conversation spent unowned before an agent picked it up. */
  timeToAssign: DurationStats;
  resolution: DurationStats;
  /** Conversations that answered at all, as a share of those measured. */
  answeredCount: number;
  answeredRate: number;
  slaBreachedCount: number;
  slaComplianceRate: number;
}

export interface ResolutionSummaryData {
  statusBreakdown: {
    open: number;
    pending: number;
    resolved: number;
    closed: number;
  };
  resolveSourceDistribution: Array<{
    source: string;
    count: number;
    percentage: number;
  }>;
  resolveReasonDistribution: Array<{
    reason: string;
    count: number;
    percentage: number;
  }>;
}

export interface MessageVolumeData {
  byType: Array<{ type: string; count: number; percentage: number }>;
  byDirection: Array<{
    direction: string;
    count: number;
    percentage: number;
  }>;
  bySenderType: Array<{
    senderType: string;
    count: number;
    percentage: number;
  }>;
}

// Phase 2 Reports

export interface BotPerformanceData {
  totalBotConversations: number;
  botResolvedCount: number;
  botResolvedRate: number;
  botHandoffCount: number;
  botHandoffRate: number;
  avgBotMessages: number;
}

export interface PeakHoursCell {
  dayOfWeek: number; // 0=Sunday … 6=Saturday
  hour: number; // 0–23
  count: number;
}

export interface TagAnalyticsItem {
  tag: string;
  tagId: string;
  color?: string;
  count: number;
  percentage: number;
}

export interface ReopenRateData {
  totalResolved: number;
  reopenedCount: number;
  reopenRate: number;
  trend: Array<{
    date: string;
    reopenedCount: number;
    resolvedCount: number;
  }>;
}
