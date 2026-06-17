// ── Volume ────────────────────────────────────────────────────────────────────
export interface TicketVolumeTrendPoint {
  date: string;
  count: number;
}

export interface TicketStatusBreakdown {
  open: number;
  pending: number;
  resolved: number;
  closed: number;
}

export interface TicketVolumeData {
  trend: TicketVolumeTrendPoint[];
  statusBreakdown: TicketStatusBreakdown;
  totalTickets: number;
}

// ── SLA Compliance ────────────────────────────────────────────────────────────
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
  byPriority: SlaByPriorityItem[];
}

// ── Resolution Time ───────────────────────────────────────────────────────────
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

// ── Agent Workload ────────────────────────────────────────────────────────────
export interface AgentWorkloadItem {
  agentId: string | null;
  agentName: string;
  agentEmail: string;
  totalTickets: number;
  resolvedTickets: number;
  avgResolutionMs: number;
  avgResolutionFormatted: string;
  breachCount: number;
  avgCsat: number | null;
}

// ── Breakdown ─────────────────────────────────────────────────────────────────
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
}

// ── CSAT ──────────────────────────────────────────────────────────────────────
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
