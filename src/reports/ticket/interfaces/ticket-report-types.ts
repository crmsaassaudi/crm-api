export interface TicketVolumeTrendPoint {
  date: string;
  count: number;
}

/** One row per status the tenant configured, in the tenant's own sort order. */
export interface TicketStatusBreakdownItem {
  statusId: string;
  label: string;
  apiName: string;
  color: string | null;
  terminalKind: 'resolved' | 'closed' | null;
  count: number;
  percentage: number;
}

export interface TicketVolumeData {
  trend: TicketVolumeTrendPoint[];
  statusBreakdown: TicketStatusBreakdownItem[];
  /** Tickets in a non-terminal status — the backlog. */
  openTickets: number;
  /** Tickets that have been reopened at least once. */
  reopenedTickets: number;
  reopenRate: number;
  totalTickets: number;
}

// SLA Compliance
export interface SlaByPriorityItem {
  priority: string;
  totalTickets: number;
  breachedCount: number;
  breachRate: number;
}

export interface SlaComplianceData {
  totalTickets: number;
  breachedCount: number;
  breachRate: number;
  frtComplianceRate: number;
  resolutionComplianceRate: number;
  /**
   * Tickets an SLA policy actually applied to. Compliance rates are computed
   * against this, not against every ticket: a tenant with no policy for LOW
   * priority would otherwise read as 0% compliant rather than "not measured".
   */
  measuredTickets: number;
  byPriority: SlaByPriorityItem[];
}

export interface ResolutionTimeByPriority {
  priority: string;
  avgResolutionMs: number;
  avgResolutionFormatted: string;
  avgFrtMs: number;
  avgFrtFormatted: string;
  count: number;
}

export interface TicketResolutionTimeData {
  avgResolutionMs: number;
  avgResolutionFormatted: string;
  avgFrtMs: number;
  avgFrtFormatted: string;
  totalResolved: number;
  byPriority: ResolutionTimeByPriority[];
}

export interface AgentWorkloadItem {
  agentId: string | null;
  agentName: string;
  agentEmail: string;
  totalTickets: number;
  /** Currently owned and not in a terminal status — the live queue depth. */
  openTickets: number;
  resolvedTickets: number;
  reopenedTickets: number;
  avgResolutionMs: number;
  avgResolutionFormatted: string;
  breachCount: number;
  avgCsat: number | null;
}

export interface BreakdownItem {
  id: string | null;
  name: string;
  count: number;
  percentage: number;
}

export interface TicketBreakdownData {
  bySource: BreakdownItem[];
  byType: BreakdownItem[];
  byPriority: BreakdownItem[];
  byCategory: BreakdownItem[];
  byChannel: BreakdownItem[];
}

export interface CsatDistributionItem {
  score: number;
  count: number;
  percentage: number;
}

export interface CsatTrendPoint {
  date: string;
  avgScore: number;
  count: number;
}

export interface CsatData {
  avgScore: number;
  totalRatings: number;
  distribution: CsatDistributionItem[];
  trend: CsatTrendPoint[];
}
