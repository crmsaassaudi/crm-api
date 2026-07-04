import {
  WorkRecord,
  computeWorkStatus,
  interactionKey,
  interactionTypeOf,
  isAllClosed,
} from './work-status';

const rec = (
  open: Record<string, number>,
  wrapUpUntilMs?: number,
): WorkRecord => ({
  open,
  wrapUpUntilMs,
});

describe('work-status helpers', () => {
  it('should interactionKey / interactionTypeOf round-trip', () => {
    const k = interactionKey('chat', 'conv-123');
    expect(k).toBe('chat:conv-123');
    expect(interactionTypeOf(k)).toBe('chat');
    expect(interactionTypeOf('ticket:abc:def')).toBe('ticket'); // refId may contain ':'
  });

  it('should isAllClosed', () => {
    expect(isAllClosed(rec({}))).toBe(true);
    expect(isAllClosed(rec({ 'chat:1': 1 }))).toBe(false);
  });
});

describe('computeWorkStatus priority (§2.4)', () => {
  it('should IN_CALL beats everything', () => {
    expect(
      computeWorkStatus(rec({ 'call:1': 1, 'chat:2': 1, 'ticket:3': 1 }), 100),
    ).toBe('IN_CALL');
  });

  it('should IN_CHAT beats ticket/email', () => {
    expect(computeWorkStatus(rec({ 'chat:1': 1, 'email:2': 1 }), 100)).toBe(
      'IN_CHAT',
    );
  });

  it('should IN_TICKET beats email', () => {
    expect(computeWorkStatus(rec({ 'ticket:1': 1, 'email:2': 1 }), 100)).toBe(
      'IN_TICKET',
    );
  });

  it('should IN_EMAIL when only email', () => {
    expect(computeWorkStatus(rec({ 'email:1': 1 }), 100)).toBe('IN_EMAIL');
  });

  it('should WRAP_UP when nothing open but within wrap window', () => {
    expect(computeWorkStatus(rec({}, 500), 100)).toBe('WRAP_UP');
  });

  it('should IDLE when nothing open and wrap window elapsed', () => {
    expect(computeWorkStatus(rec({}, 500), 600)).toBe('IDLE');
    expect(computeWorkStatus(rec({}), 600)).toBe('IDLE');
  });

  it('should open interaction overrides a stale wrap window', () => {
    expect(computeWorkStatus(rec({ 'chat:1': 1 }, 500), 600)).toBe('IN_CHAT');
  });
});
