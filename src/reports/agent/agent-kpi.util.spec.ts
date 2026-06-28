import { computeKpis, formatDuration, minMaxNormalize } from './agent-kpi.util';

const H = 3_600_000; // 1h in ms
const M = 60_000;

describe('computeKpis (§4.2)', () => {
  it('TC08: Occupancy = (handle+wrap)/available, Utilization = /online', () => {
    // available 7h (handle 4h, wrap 45m, idle 2h15m), away 20m, break 1h, meeting 30m
    const k = computeKpis({
      availableMs: 7 * H,
      awayMs: 20 * M,
      breakMs: 1 * H,
      meetingMs: 30 * M,
      trainingMs: 0,
      acceptingMs: 0,
      notAcceptingMs: 0,
      handleMs: 4 * H,
      wrapMs: 45 * M,
      idleMs: 0,
      handledCount: 12,
    });
    expect(k.onlineMs).toBe(7 * H + 20 * M + 1 * H + 30 * M); // 8h50m
    // (4h+45m)/7h = 285/420
    expect(k.occupancy).toBeCloseTo(285 / 420, 5); // ~0.6786
    expect(k.utilization).toBeCloseTo((285 * M) / (530 * M), 5); // ~0.538
    expect(k.ahtMs).toBeCloseTo((4 * H + 45 * M) / 12, 5); // 23.75m
  });

  it('availabilityRatio = accepting/online', () => {
    const k = computeKpis({
      availableMs: 9 * H,
      awayMs: 0,
      breakMs: 0,
      meetingMs: 0,
      trainingMs: 0,
      acceptingMs: 6 * H + 55 * M,
      notAcceptingMs: 2 * H + 5 * M,
      handleMs: 0,
      wrapMs: 0,
      idleMs: 9 * H,
      handledCount: 0,
    });
    expect(k.availabilityRatio).toBeCloseTo((6 * H + 55 * M) / (9 * H), 5);
    expect(k.ahtMs).toBe(0); // no division by zero
  });

  it('guards division by zero', () => {
    const k = computeKpis({
      availableMs: 0,
      awayMs: 0,
      breakMs: 0,
      meetingMs: 0,
      trainingMs: 0,
      acceptingMs: 0,
      notAcceptingMs: 0,
      handleMs: 0,
      wrapMs: 0,
      idleMs: 0,
      handledCount: 0,
    });
    expect(k.occupancy).toBe(0);
    expect(k.utilization).toBe(0);
  });
});

describe('minMaxNormalize', () => {
  it('normalizes to [0,1]', () => {
    expect(minMaxNormalize([0, 5, 10])).toEqual([0, 0.5, 1]);
  });
  it('all-equal → all 1', () => {
    expect(minMaxNormalize([4, 4, 4])).toEqual([1, 1, 1]);
  });
  it('empty → empty', () => {
    expect(minMaxNormalize([])).toEqual([]);
  });
});

describe('formatDuration', () => {
  it('formats h/m', () => {
    expect(formatDuration(0)).toBe('0m');
    expect(formatDuration(45 * M)).toBe('45m');
    expect(formatDuration(2 * H)).toBe('2h');
    expect(formatDuration(2 * H + 30 * M)).toBe('2h 30m');
  });
});
