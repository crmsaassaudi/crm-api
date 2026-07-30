import {
  canAcceptBotCallback,
  resolveBotTransition,
} from './bot-state-machine';

describe('bot state machine', () => {
  const active = {
    enabled: true,
    provider: 'typebot',
    sessionId: 'session_1',
    status: 'active' as const,
  };

  it('should rejects stale callbacks after handoff or agent takeover', () => {
    expect(
      canAcceptBotCallback({ ...active, enabled: false, status: 'handoff' }),
    ).toBe(false);
    expect(
      canAcceptBotCallback({ ...active, enabled: false, status: 'ended' }),
    ).toBe(false);
  });

  it('should fences callbacks from an older provider session', () => {
    expect(canAcceptBotCallback(active, 'session_2')).toBe(false);
    expect(canAcceptBotCallback(active, 'session_1')).toBe(true);
  });

  it('should requires explicit agent enable to leave terminal bot states', () => {
    expect(resolveBotTransition('handoff', 'callback_active')).toBeNull();
    expect(resolveBotTransition('ended', 'callback_active')).toBeNull();
    expect(resolveBotTransition('handoff', 'agent_enable')).toBe('active');
  });
});
