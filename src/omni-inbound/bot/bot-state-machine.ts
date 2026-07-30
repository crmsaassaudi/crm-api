import { ConversationBotState } from '../domain/omni-conversation';

export type BotLifecycleEvent =
  | 'callback_active'
  | 'callback_handoff'
  | 'callback_ended'
  | 'agent_disable'
  | 'agent_enable';

const transitions: Record<
  ConversationBotState['status'],
  Partial<Record<BotLifecycleEvent, ConversationBotState['status']>>
> = {
  active: {
    callback_active: 'active',
    callback_handoff: 'handoff',
    callback_ended: 'ended',
    agent_disable: 'ended',
  },
  handoff: {
    agent_enable: 'active',
  },
  ended: {
    agent_enable: 'active',
  },
};

export function resolveBotTransition(
  current: ConversationBotState['status'],
  event: BotLifecycleEvent,
): ConversationBotState['status'] | null {
  return transitions[current][event] ?? null;
}

/**
 * A callback is accepted only for the currently active bot session. This is
 * the fencing rule that prevents a delayed provider callback from reviving a
 * bot after agent takeover or handoff.
 */
export function canAcceptBotCallback(
  bot: ConversationBotState | null | undefined,
  callbackSessionId?: string,
): boolean {
  if (!bot?.enabled || bot.status !== 'active') return false;
  return !(
    bot.sessionId &&
    callbackSessionId &&
    bot.sessionId !== callbackSessionId
  );
}
