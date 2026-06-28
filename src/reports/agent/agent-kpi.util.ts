// Pure KPI math for agent reports (docs/agent-presence-workforce-spec.md §4.2/§4.3).
// Kept pure so the formulas are unit-tested independently of Mongo/DI.

export interface KpiDurations {
  availableMs: number;
  awayMs: number;
  breakMs: number;
  meetingMs: number;
  trainingMs: number;
  acceptingMs: number;
  notAcceptingMs: number;
  handleMs: number;
  wrapMs: number;
  idleMs: number;
  handledCount: number;
}

export interface AgentKpis {
  onlineMs: number;
  occupancy: number;
  utilization: number;
  availabilityRatio: number;
  idleRatio: number;
  ahtMs: number;
}

const ratio = (num: number, den: number): number => (den > 0 ? num / den : 0);

export function computeKpis(d: KpiDurations): AgentKpis {
  const onlineMs =
    d.availableMs + d.awayMs + d.breakMs + d.meetingMs + d.trainingMs;
  const handleWrap = d.handleMs + d.wrapMs;
  return {
    onlineMs,
    occupancy: ratio(handleWrap, d.availableMs),
    utilization: ratio(handleWrap, onlineMs),
    availabilityRatio: ratio(d.acceptingMs, onlineMs),
    idleRatio: ratio(d.idleMs, onlineMs),
    ahtMs: d.handledCount > 0 ? handleWrap / d.handledCount : 0,
  };
}

/** Min-max normalize to [0,1]; all-equal → all 1 (no spurious ranking spread). */
export function minMaxNormalize(values: number[]): number[] {
  if (values.length === 0) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return values.map(() => 1);
  return values.map((v) => (v - min) / (max - min));
}

export function formatDuration(ms: number): string {
  if (!ms || ms <= 0) return '0m';
  const totalMinutes = Math.floor(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}
