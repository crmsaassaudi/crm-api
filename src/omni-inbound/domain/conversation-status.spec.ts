import {
  assertConversationStatusTransition,
  canTransitionConversationStatus,
  isConversationStatus,
} from './conversation-status';

describe('conversation status state machine', () => {
  it.each([
    ['open', 'pending'],
    ['open', 'resolved'],
    ['open', 'closed'],
    ['pending', 'open'],
    ['pending', 'resolved'],
    ['pending', 'closed'],
    ['resolved', 'open'],
    ['resolved', 'closed'],
  ] as const)('allows %s -> %s', (current, next) => {
    expect(canTransitionConversationStatus(current, next)).toBe(true);
  });

  it.each([
    ['resolved', 'pending'],
    ['closed', 'open'],
    ['closed', 'pending'],
    ['closed', 'resolved'],
  ] as const)('rejects %s -> %s', (current, next) => {
    expect(canTransitionConversationStatus(current, next)).toBe(false);
    expect(() => assertConversationStatusTransition(current, next)).toThrow(
      `Conversation status cannot transition from ${current} to ${next}`,
    );
  });

  it('should treat a repeated command as idempotent', () => {
    expect(canTransitionConversationStatus('resolved', 'resolved')).toBe(true);
  });

  it('should recognize only canonical statuses', () => {
    expect(isConversationStatus('open')).toBe(true);
    expect(isConversationStatus('snoozed')).toBe(false);
    expect(isConversationStatus(undefined)).toBe(false);
  });
});
