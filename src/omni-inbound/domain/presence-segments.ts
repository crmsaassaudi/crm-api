// ─── Presence Reporting Segments (pure diff logic) ──────────────────────────
//
// Each axis (presence / routing / work) produces a timeline of CLOSED segments
// for reporting (docs/agent-presence-workforce-spec.md §3.1). When an axis
// value changes we close the open segment (stamp endAt + durationMs) and open a
// new one. OFFLINE closes every open segment and opens none — offline time is
// outside T_online and is not tracked as a segment (§4.1).
//
// This module is pure so the close/open arithmetic can be unit-tested in
// isolation; the service layer adds Redis (open-segment store) + the queue.
// ─────────────────────────────────────────────────────────────────────────────

import { PresenceStatus, RoutingStatus, WorkStatus } from './presence-state';

export type SegmentAxis = 'presence' | 'routing' | 'work';

export const SEGMENT_AXES: readonly SegmentAxis[] = [
  'presence',
  'routing',
  'work',
];

/** An open segment held in Redis: the current value + when it started. */
export interface OpenSegment {
  value: string;
  startAtMs: number;
}

export type OpenSegmentMap = Partial<Record<SegmentAxis, OpenSegment>>;

/** A closed segment to be persisted to `agent_state_segments`. */
export interface ClosedSegment {
  axis: SegmentAxis;
  value: string;
  startAtMs: number;
  endAtMs: number;
  durationMs: number;
}

/** The canonical axis values of an agent at a point in time. */
export interface AxisSnapshot {
  presenceStatus: PresenceStatus;
  routingStatus: RoutingStatus;
  workStatus: WorkStatus;
}

const axisValue = (snap: AxisSnapshot, axis: SegmentAxis): string => {
  switch (axis) {
    case 'presence':
      return snap.presenceStatus;
    case 'routing':
      return snap.routingStatus;
    case 'work':
      return snap.workStatus;
  }
};

const close = (
  axis: SegmentAxis,
  open: OpenSegment,
  endAtMs: number,
): ClosedSegment => ({
  axis,
  value: open.value,
  startAtMs: open.startAtMs,
  endAtMs,
  durationMs: Math.max(0, endAtMs - open.startAtMs),
});

/**
 * Diff the currently-open segments against the new state snapshot.
 *
 * @returns `closed` — segments to persist; `next` — the new open-segment map to
 * store back in Redis.
 *
 * Rules:
 *   - OFFLINE: close every open segment, open none.
 *   - online + axis unchanged: keep the open segment as-is.
 *   - online + axis changed (or none open): close the old (if any) and open a
 *     new segment starting at `atMs`.
 */
export function diffSegments(
  open: OpenSegmentMap,
  after: AxisSnapshot,
  atMs: number,
): { closed: ClosedSegment[]; next: OpenSegmentMap } {
  const closed: ClosedSegment[] = [];

  if (after.presenceStatus === 'OFFLINE') {
    for (const axis of SEGMENT_AXES) {
      const cur = open[axis];
      if (cur) closed.push(close(axis, cur, atMs));
    }
    return { closed, next: {} };
  }

  const next: OpenSegmentMap = { ...open };
  for (const axis of SEGMENT_AXES) {
    const value = axisValue(after, axis);
    const cur = open[axis];
    if (!cur) {
      next[axis] = { value, startAtMs: atMs };
    } else if (cur.value !== value) {
      closed.push(close(axis, cur, atMs));
      next[axis] = { value, startAtMs: atMs };
    }
    // unchanged → keep cur
  }
  return { closed, next };
}

/**
 * Day-boundary rollover (§3.2): close every open segment at `boundaryMs` and
 * re-open it (same value) starting at `boundaryMs`, so no segment spans two
 * days and each day's totals are self-contained.
 */
export function rolloverSegments(
  open: OpenSegmentMap,
  boundaryMs: number,
): { closed: ClosedSegment[]; next: OpenSegmentMap } {
  const closed: ClosedSegment[] = [];
  const next: OpenSegmentMap = {};
  for (const axis of SEGMENT_AXES) {
    const cur = open[axis];
    if (cur) {
      closed.push(close(axis, cur, boundaryMs));
      next[axis] = { value: cur.value, startAtMs: boundaryMs };
    }
  }
  return { closed, next };
}

/** UTC day key (YYYY-MM-DD) of a timestamp — used to bucket/query segments. */
export function dayKeyOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
