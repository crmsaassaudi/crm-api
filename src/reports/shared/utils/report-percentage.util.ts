/**
 * `part / total * 100`, safe against a zero denominator.
 *
 * Used to be `total > 0 ? ... : 100` — a zero-denominator "rate" is reported
 * as 0%, not 100%. The old default silently corrupted every headline KPI
 * built on this: a brand-new deal pipeline with 5 open deals and zero
 * won/lost reported `winRate: 100`; the same shape hit every distribution
 * percentage (`row.count / total`) and compliance rate (`frtComplianceRate`,
 * `resolutionComplianceRate`) built on this shared util the moment their
 * denominator was zero. "Nothing measured yet" reads as "fully compliant" or
 * "100% won" to anyone glancing at the number — 0 is the only default that
 * doesn't misrepresent an empty state as a real result.
 */
export const safePercent = (part: number, total: number): number =>
  total > 0 ? Math.round((part / total) * 100) : 0;
