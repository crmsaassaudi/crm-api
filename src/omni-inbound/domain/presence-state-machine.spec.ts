import { AgentState } from './presence-state';
import {
  applyDayRolloverReset,
  applyLogin,
  canTransitionPresence,
  forceOffline,
  isStaleCommand,
  setRouting,
  TransitionContext,
  transitionPresence,
} from './presence-state-machine';

const ctx = (over: Partial<TransitionContext> = {}): TransitionContext => ({
  trigger: 'agent_manual',
  nowMs: 2_000,
  actor: 'agent',
  ...over,
});

const state = (over: Partial<AgentState> = {}): AgentState => ({
  presenceStatus: 'AVAILABLE',
  routingStatus: 'ACCEPTING',
  workStatus: 'IDLE',
  connectionStatus: 'CONNECTED',
  currentLoad: 0,
  maxLoad: 5,
  updatedAtMs: 1_000,
  ...over,
});

describe('canTransitionPresence (§2.2 matrix)', () => {
  it('should OFFLINE only → AVAILABLE', () => {
    expect(canTransitionPresence('OFFLINE', 'AVAILABLE')).toBe(true);
    expect(canTransitionPresence('OFFLINE', 'BREAK')).toBe(false);
    expect(canTransitionPresence('OFFLINE', 'MEETING')).toBe(false);
  });

  it('should agent cannot self-select OFFLINE; system/supervisor can', () => {
    expect(canTransitionPresence('AVAILABLE', 'OFFLINE', 'agent')).toBe(false);
    expect(canTransitionPresence('AVAILABLE', 'OFFLINE', 'system')).toBe(true);
    expect(canTransitionPresence('AVAILABLE', 'OFFLINE', 'supervisor')).toBe(
      true,
    );
  });

  it('should online → online always allowed', () => {
    expect(canTransitionPresence('AVAILABLE', 'MEETING')).toBe(true);
    expect(canTransitionPresence('BREAK', 'AVAILABLE')).toBe(true);
    expect(canTransitionPresence('MEETING', 'TRAINING')).toBe(true);
  });
});

describe('transitionPresence routing interlock (§1.2)', () => {
  it('should leaving AVAILABLE forces NOT_ACCEPTING', () => {
    const r = transitionPresence(
      state({ routingStatus: 'ACCEPTING' }),
      'MEETING',
      ctx(),
    );
    expect(r.ok).toBe(true);
    expect(r.state.presenceStatus).toBe('MEETING');
    expect(r.state.routingStatus).toBe('NOT_ACCEPTING');
    expect(r.changed.sort()).toEqual(['presence', 'routing']);
  });

  it('should returning to AVAILABLE keeps NOT_ACCEPTING by default (restore=false)', () => {
    const meeting = state({
      presenceStatus: 'MEETING',
      routingStatus: 'NOT_ACCEPTING',
    });
    const r = transitionPresence(
      meeting,
      'AVAILABLE',
      ctx({ restoreAcceptingOnReturn: false }),
    );
    expect(r.state.presenceStatus).toBe('AVAILABLE');
    expect(r.state.routingStatus).toBe('NOT_ACCEPTING');
    expect(r.changed).toEqual(['presence']);
  });

  it('should returning to AVAILABLE restores ACCEPTING when restore=true and was accepting', () => {
    const meeting = state({
      presenceStatus: 'MEETING',
      routingStatus: 'NOT_ACCEPTING',
    });
    const r = transitionPresence(
      meeting,
      'AVAILABLE',
      ctx({ restoreAcceptingOnReturn: true, wasAcceptingBeforeLeave: true }),
    );
    expect(r.state.routingStatus).toBe('ACCEPTING');
    expect(r.changed.sort()).toEqual(['presence', 'routing']);
  });

  it('should restore=true but was NOT accepting before leave → stays NOT_ACCEPTING', () => {
    const meeting = state({
      presenceStatus: 'MEETING',
      routingStatus: 'NOT_ACCEPTING',
    });
    const r = transitionPresence(
      meeting,
      'AVAILABLE',
      ctx({ restoreAcceptingOnReturn: true, wasAcceptingBeforeLeave: false }),
    );
    expect(r.state.routingStatus).toBe('NOT_ACCEPTING');
  });

  it('should rejects illegal transition without mutating state', () => {
    const off = state({
      presenceStatus: 'OFFLINE',
      routingStatus: 'NOT_ACCEPTING',
    });
    const r = transitionPresence(off, 'BREAK', ctx());
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Illegal/);
    expect(r.state).toBe(off);
  });
});

describe('setRouting (Ready toggle)', () => {
  it('should can start ACCEPTING when AVAILABLE + CONNECTED', () => {
    const s = state({ routingStatus: 'NOT_ACCEPTING' });
    const r = setRouting(s, 'ACCEPTING', ctx());
    expect(r.ok).toBe(true);
    expect(r.state.routingStatus).toBe('ACCEPTING');
    expect(r.changed).toEqual(['routing']);
  });

  it('should cannot accept while not AVAILABLE', () => {
    const s = state({
      presenceStatus: 'BREAK',
      routingStatus: 'NOT_ACCEPTING',
    });
    const r = setRouting(s, 'ACCEPTING', ctx());
    expect(r.ok).toBe(false);
  });

  it('should cannot start ACCEPTING while disconnected', () => {
    const s = state({
      routingStatus: 'NOT_ACCEPTING',
      connectionStatus: 'DISCONNECTED',
    });
    const r = setRouting(s, 'ACCEPTING', ctx());
    expect(r.ok).toBe(false);
  });

  it('should no-op when already in target routing', () => {
    const s = state({ routingStatus: 'ACCEPTING' });
    const r = setRouting(s, 'ACCEPTING', ctx());
    expect(r.ok).toBe(true);
    expect(r.changed).toEqual([]);
  });
});

describe('login / logout (§2.2, TC04)', () => {
  it('should login always lands AVAILABLE + NOT_ACCEPTING (never ACCEPTING)', () => {
    const off = state({
      presenceStatus: 'OFFLINE',
      routingStatus: 'NOT_ACCEPTING',
      connectionStatus: 'DISCONNECTED',
    });
    const r = applyLogin(off, 5_000);
    expect(r.state.presenceStatus).toBe('AVAILABLE');
    expect(r.state.routingStatus).toBe('NOT_ACCEPTING');
    expect(r.state.connectionStatus).toBe('CONNECTED');
  });

  it('should forceOffline closes routing', () => {
    const r = forceOffline(
      state({ routingStatus: 'ACCEPTING' }),
      ctx({ trigger: 'system_grace_expired', actor: 'system' }),
    );
    expect(r.state.presenceStatus).toBe('OFFLINE');
    expect(r.state.routingStatus).toBe('NOT_ACCEPTING');
    expect(r.state.connectionStatus).toBe('DISCONNECTED');
  });
});

describe('day rollover (§3.2, TC04)', () => {
  it('should resets ACCEPTING → NOT_ACCEPTING at midnight, presence unchanged', () => {
    const s = state({
      presenceStatus: 'AVAILABLE',
      routingStatus: 'ACCEPTING',
    });
    const r = applyDayRolloverReset(s, 9_000);
    expect(r.state.presenceStatus).toBe('AVAILABLE');
    expect(r.state.routingStatus).toBe('NOT_ACCEPTING');
    expect(r.changed).toEqual(['routing']);
  });

  it('should no-op when already NOT_ACCEPTING', () => {
    const r = applyDayRolloverReset(
      state({ routingStatus: 'NOT_ACCEPTING' }),
      9_000,
    );
    expect(r.changed).toEqual([]);
  });
});

describe('multi-device LWW guard (§1.6, TC11)', () => {
  it('should drops a command older than the last applied one', () => {
    expect(isStaleCommand(100, 200)).toBe(true); // delayed device A command
    expect(isStaleCommand(300, 200)).toBe(false); // newer wins
    expect(isStaleCommand(200, 200)).toBe(false); // equal applies
    expect(isStaleCommand(100, undefined)).toBe(false); // first command
  });
});

describe('TC01 routing timeline (default restore=false)', () => {
  it('should returning to AVAILABLE from MEETING/BREAK does not re-arm ACCEPTING', () => {
    // 08:05 ACCEPTING
    let s = state({ presenceStatus: 'AVAILABLE', routingStatus: 'ACCEPTING' });
    // 10:00 MEETING → NOT_ACCEPTING
    s = transitionPresence(s, 'MEETING', ctx()).state;
    expect(s.routingStatus).toBe('NOT_ACCEPTING');
    // 11:00 back to AVAILABLE → still NOT_ACCEPTING (default)
    s = transitionPresence(
      s,
      'AVAILABLE',
      ctx({ restoreAcceptingOnReturn: false }),
    ).state;
    expect(s).toMatchObject({
      presenceStatus: 'AVAILABLE',
      routingStatus: 'NOT_ACCEPTING',
    });
    // 12:00 BREAK → NOT_ACCEPTING ; 13:00 AVAILABLE → still NOT_ACCEPTING
    s = transitionPresence(s, 'BREAK', ctx()).state;
    s = transitionPresence(
      s,
      'AVAILABLE',
      ctx({ restoreAcceptingOnReturn: false }),
    ).state;
    expect(s.routingStatus).toBe('NOT_ACCEPTING');
  });

  it('should variant restore=true re-arms ACCEPTING on return', () => {
    let s = state({ presenceStatus: 'AVAILABLE', routingStatus: 'ACCEPTING' });
    s = transitionPresence(s, 'MEETING', ctx()).state;
    s = transitionPresence(
      s,
      'AVAILABLE',
      ctx({ restoreAcceptingOnReturn: true, wasAcceptingBeforeLeave: true }),
    ).state;
    expect(s.routingStatus).toBe('ACCEPTING');
  });
});
