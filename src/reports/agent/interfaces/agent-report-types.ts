/** Per-channel handle aggregation (overlap-allowed interaction_segments). */
export interface ChannelHandle {
  durationMs: number;
  durationFormatted: string;
  count: number;
}

/** Work-time + KPI summary for a single agent over the report period. */
export interface AgentWorkTimeItem {
  agentId: string;
  agentName: string;
  agentEmail: string;

  // Presence durations (ms) — sum = onlineMs (T_online)
  presence: {
    availableMs: number;
    awayMs: number;
    breakMs: number;
    meetingMs: number;
    trainingMs: number;
  };
  onlineMs: number;

  // Routing durations (ms) — sum = onlineMs
  routing: {
    acceptingMs: number;
    notAcceptingMs: number;
  };

  // Work durations (ms) — sum = onlineMs
  work: {
    handleMs: number; // IN_CHAT + IN_TICKET + IN_EMAIL + IN_CALL
    wrapMs: number; // WRAP_UP
    idleMs: number; // IDLE
  };

  handledCount: number;
  byChannel: Record<'chat' | 'ticket' | 'email' | 'call', ChannelHandle>;

  // KPIs (§4.2)
  occupancy: number; // (handle+wrap)/available
  utilization: number; // (handle+wrap)/online
  availabilityRatio: number; // accepting/online
  idleRatio: number; // idle/online
  ahtMs: number; // (handle+wrap)/handledCount

  // Pre-formatted for the UI
  onlineFormatted: string;
  availableFormatted: string;
  handleFormatted: string;
  wrapFormatted: string;
  ahtFormatted: string;
}

export interface AgentWorkTimeTeam {
  agentCount: number;
  onlineMs: number;
  availableMs: number;
  handleMs: number;
  handledCount: number;
  avgOccupancy: number;
  avgUtilization: number;
}

export interface AgentWorkTimeData {
  agents: AgentWorkTimeItem[];
  team: AgentWorkTimeTeam;
}

/** One ranked agent (Agent Performance Index, §4.3). */
export interface AgentRankingItem {
  agentId: string;
  agentName: string;
  rank: number | null; // null when below guardrail thresholds
  score: number; // 0..1
  ranked: boolean;
  notRankedReason?: string;
  components: {
    occupancy: number;
    availabilityRatio: number;
    handledCount: number;
    ahtMs: number;
  };
}

export interface AgentRankingData {
  weights: Record<string, number>;
  thresholds: { minOnlineMinutes: number; minHandled: number };
  agents: AgentRankingItem[];
}
