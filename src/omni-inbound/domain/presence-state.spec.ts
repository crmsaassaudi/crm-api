import {
  AgentState,
  computeCapacityStatus,
  computeDisplayStatus,
  deriveWorkStatus,
  fromLegacyIntent,
  isEligibleForRouting,
  isFull,
  isOnline,
  isRoutablePresence,
  LegacyIntentStatus,
  toLegacyIntent,
} from './presence-state';

const base: AgentState = {
  presenceStatus: 'AVAILABLE',
  routingStatus: 'ACCEPTING',
  workStatus: 'IDLE',
  connectionStatus: 'CONNECTED',
  currentLoad: 0,
  maxLoad: 5,
  updatedAtMs: 1_000,
};

describe('presence-state predicates', () => {
  it('isOnline: only OFFLINE is offline', () => {
    expect(isOnline('AVAILABLE')).toBe(true);
    expect(isOnline('BREAK')).toBe(true);
    expect(isOnline('OFFLINE')).toBe(false);
  });

  it('isRoutablePresence: only AVAILABLE', () => {
    expect(isRoutablePresence('AVAILABLE')).toBe(true);
    for (const p of ['AWAY', 'BREAK', 'MEETING', 'TRAINING', 'OFFLINE'] as const) {
      expect(isRoutablePresence(p)).toBe(false);
    }
  });

  it('capacity status & isFull', () => {
    expect(computeCapacityStatus(4, 5)).toBe('OK');
    expect(computeCapacityStatus(5, 5)).toBe('FULL');
    expect(isFull({ currentLoad: 5, maxLoad: 5 })).toBe(true);
    expect(isFull({ currentLoad: 4, maxLoad: 5 })).toBe(false);
  });
});

describe('isEligibleForRouting — 4 independent gates (§2.1)', () => {
  it('eligible when all gates pass', () => {
    expect(isEligibleForRouting(base)).toBe(true);
  });

  it('fails if not AVAILABLE', () => {
    expect(isEligibleForRouting({ ...base, presenceStatus: 'BREAK' })).toBe(false);
    expect(isEligibleForRouting({ ...base, presenceStatus: 'MEETING' })).toBe(false);
  });

  it('fails if disconnected', () => {
    expect(
      isEligibleForRouting({ ...base, connectionStatus: 'DISCONNECTED' }),
    ).toBe(false);
  });

  it('fails if NOT_ACCEPTING (Busy)', () => {
    expect(isEligibleForRouting({ ...base, routingStatus: 'NOT_ACCEPTING' })).toBe(
      false,
    );
  });

  it('fails when FULL (currentLoad >= maxLoad) — TC07', () => {
    expect(isEligibleForRouting({ ...base, currentLoad: 5, maxLoad: 5 })).toBe(
      false,
    );
    expect(isEligibleForRouting({ ...base, currentLoad: 4, maxLoad: 5 })).toBe(
      true,
    );
  });

  it('workStatus does NOT gate routing — IN_CHAT agent still eligible until FULL', () => {
    const inChat: AgentState = { ...base, workStatus: 'IN_CHAT', currentLoad: 2 };
    expect(isEligibleForRouting(inChat)).toBe(true);
  });
});

describe('legacy interop (§1.2: Busy = AVAILABLE + NOT_ACCEPTING)', () => {
  it('toLegacyIntent', () => {
    expect(toLegacyIntent('AVAILABLE', 'ACCEPTING')).toBe('available');
    expect(toLegacyIntent('AVAILABLE', 'NOT_ACCEPTING')).toBe('busy');
    expect(toLegacyIntent('AWAY', 'NOT_ACCEPTING')).toBe('away');
    expect(toLegacyIntent('BREAK', 'NOT_ACCEPTING')).toBe('away');
    expect(toLegacyIntent('MEETING', 'NOT_ACCEPTING')).toBe('away');
    expect(toLegacyIntent('OFFLINE', 'NOT_ACCEPTING')).toBe('offline');
  });

  it('fromLegacyIntent', () => {
    expect(fromLegacyIntent('available')).toEqual({
      presenceStatus: 'AVAILABLE',
      routingStatus: 'ACCEPTING',
    });
    expect(fromLegacyIntent('busy')).toEqual({
      presenceStatus: 'AVAILABLE',
      routingStatus: 'NOT_ACCEPTING',
    });
    expect(fromLegacyIntent('away')).toEqual({
      presenceStatus: 'AWAY',
      routingStatus: 'NOT_ACCEPTING',
    });
    expect(fromLegacyIntent('offline')).toEqual({
      presenceStatus: 'OFFLINE',
      routingStatus: 'NOT_ACCEPTING',
    });
  });

  it('round-trips for the four legacy values', () => {
    const intents: LegacyIntentStatus[] = ['available', 'busy', 'away', 'offline'];
    for (const intent of intents) {
      const { presenceStatus, routingStatus } = fromLegacyIntent(intent);
      expect(toLegacyIntent(presenceStatus, routingStatus)).toBe(intent);
    }
  });
});

describe('computeDisplayStatus', () => {
  it('disconnected or OFFLINE → offline', () => {
    expect(computeDisplayStatus('AVAILABLE', 'ACCEPTING', 'DISCONNECTED')).toBe(
      'offline',
    );
    expect(computeDisplayStatus('OFFLINE', 'NOT_ACCEPTING', 'CONNECTED')).toBe(
      'offline',
    );
  });

  it('connected mirrors legacy intent', () => {
    expect(computeDisplayStatus('AVAILABLE', 'ACCEPTING', 'CONNECTED')).toBe(
      'available',
    );
    expect(computeDisplayStatus('AVAILABLE', 'NOT_ACCEPTING', 'CONNECTED')).toBe(
      'busy',
    );
    expect(computeDisplayStatus('BREAK', 'NOT_ACCEPTING', 'CONNECTED')).toBe('away');
  });
});

describe('deriveWorkStatus priority (§2.4)', () => {
  it('respects IN_CALL > IN_CHAT > IN_TICKET > IN_EMAIL > WRAP_UP > IDLE', () => {
    expect(deriveWorkStatus({ call: true, chat: true })).toBe('IN_CALL');
    expect(deriveWorkStatus({ chat: true, ticket: true })).toBe('IN_CHAT');
    expect(deriveWorkStatus({ ticket: true, email: true })).toBe('IN_TICKET');
    expect(deriveWorkStatus({ email: true, wrapUp: true })).toBe('IN_EMAIL');
    expect(deriveWorkStatus({ wrapUp: true })).toBe('WRAP_UP');
    expect(deriveWorkStatus({})).toBe('IDLE');
  });
});
