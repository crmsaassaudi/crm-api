import {
  AxisSnapshot,
  OpenSegmentMap,
  dayKeyOf,
  diffSegments,
  rolloverSegments,
} from './presence-segments';

const snap = (over: Partial<AxisSnapshot> = {}): AxisSnapshot => ({
  presenceStatus: 'AVAILABLE',
  routingStatus: 'NOT_ACCEPTING',
  workStatus: 'IDLE',
  ...over,
});

describe('diffSegments', () => {
  it('opens fresh segments when nothing is open', () => {
    const { closed, next } = diffSegments({}, snap(), 1_000);
    expect(closed).toEqual([]);
    expect(next).toEqual({
      presence: { value: 'AVAILABLE', startAtMs: 1_000 },
      routing: { value: 'NOT_ACCEPTING', startAtMs: 1_000 },
      work: { value: 'IDLE', startAtMs: 1_000 },
    });
  });

  it('closes only the axis that changed', () => {
    const open: OpenSegmentMap = {
      presence: { value: 'AVAILABLE', startAtMs: 1_000 },
      routing: { value: 'NOT_ACCEPTING', startAtMs: 1_000 },
      work: { value: 'IDLE', startAtMs: 1_000 },
    };
    // agent presses Ready at t=3000 → routing changes, others unchanged
    const { closed, next } = diffSegments(open, snap({ routingStatus: 'ACCEPTING' }), 3_000);
    expect(closed).toEqual([
      { axis: 'routing', value: 'NOT_ACCEPTING', startAtMs: 1_000, endAtMs: 3_000, durationMs: 2_000 },
    ]);
    expect(next.routing).toEqual({ value: 'ACCEPTING', startAtMs: 3_000 });
    expect(next.presence).toEqual(open.presence); // untouched
  });

  it('OFFLINE closes all open segments and opens none', () => {
    const open: OpenSegmentMap = {
      presence: { value: 'AVAILABLE', startAtMs: 1_000 },
      routing: { value: 'ACCEPTING', startAtMs: 1_000 },
      work: { value: 'IN_CHAT', startAtMs: 2_000 },
    };
    const { closed, next } = diffSegments(open, snap({ presenceStatus: 'OFFLINE' }), 5_000);
    expect(next).toEqual({});
    expect(closed).toHaveLength(3);
    const work = closed.find((c) => c.axis === 'work')!;
    expect(work).toEqual({ axis: 'work', value: 'IN_CHAT', startAtMs: 2_000, endAtMs: 5_000, durationMs: 3_000 });
  });

  it('no-op when nothing changed (idempotent heartbeat)', () => {
    const open: OpenSegmentMap = {
      presence: { value: 'AVAILABLE', startAtMs: 1_000 },
      routing: { value: 'NOT_ACCEPTING', startAtMs: 1_000 },
      work: { value: 'IDLE', startAtMs: 1_000 },
    };
    const { closed, next } = diffSegments(open, snap(), 9_000);
    expect(closed).toEqual([]);
    expect(next).toEqual(open);
  });
});

describe('rolloverSegments (§3.2)', () => {
  it('closes at the boundary and re-opens with same value', () => {
    const open: OpenSegmentMap = {
      presence: { value: 'AVAILABLE', startAtMs: 1_000 },
      routing: { value: 'ACCEPTING', startAtMs: 1_000 },
    };
    const boundary = 10_000;
    const { closed, next } = rolloverSegments(open, boundary);
    expect(closed).toHaveLength(2);
    expect(closed.every((c) => c.endAtMs === boundary)).toBe(true);
    expect(next.presence).toEqual({ value: 'AVAILABLE', startAtMs: boundary });
    expect(next.routing).toEqual({ value: 'ACCEPTING', startAtMs: boundary });
  });

  it('TC01-style invariant: presence durations across a change sum correctly', () => {
    // AVAILABLE 1000→3000 (2000), then MEETING from 3000.
    let open: OpenSegmentMap = {};
    let r = diffSegments(open, snap({ presenceStatus: 'AVAILABLE' }), 1_000);
    open = r.next;
    r = diffSegments(open, snap({ presenceStatus: 'MEETING' }), 3_000);
    open = r.next;
    const presenceClosed = r.closed.find((c) => c.axis === 'presence')!;
    expect(presenceClosed.durationMs).toBe(2_000);
  });
});

describe('dayKeyOf', () => {
  it('returns the UTC date', () => {
    expect(dayKeyOf(Date.UTC(2026, 5, 28, 23, 30))).toBe('2026-06-28');
    expect(dayKeyOf(Date.UTC(2026, 5, 28, 0, 0))).toBe('2026-06-28');
  });
});
