// ── Phase 1 Reports ─────────────────────────────────────────────────

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
  frtBreachCount: number;
  frtBreachRate: number;
  resolutionBreachCount: number;
  resolutionBreachRate: number;
  avgMessageCount: number;
}

export interface ResponseTimeData {
  totalConversations: number;
  avgResolutionMs: number;
  avgResolutionFormatted: string;
  frtBreachedCount: number;
  frtComplianceRate: number;
  resolutionBreachedCount: number;
  resolutionComplianceRate: number;
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

// ── Phase 2 Reports ─────────────────────────────────────────────────

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
