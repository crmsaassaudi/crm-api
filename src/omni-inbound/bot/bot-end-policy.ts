import { BotMode } from '../domain/omni-conversation';

export type BotEndReason = 'flow_completed' | 'no_flow_bound';

/**
 * Should a bot session that ended WITHOUT a handoff release the conversation to
 * a human?
 *
 * This exists because `bot_first` defers auto-assignment at conversation
 * creation: the conversation is deliberately left unassigned while the bot
 * works. If nothing re-triggers assignment when the bot stops, the conversation
 * is stranded — no bot, no agent — and the customer's next message is skipped by
 * the bot processor.
 *
 * - `bot_first`: always release. The bot was the first line, not the only one.
 * - `bot_only`:  keep conversations away from agents by design — EXCEPT when the
 *   channel has no flow bound at all, where there is no bot to speak of and
 *   leaving the conversation stranded helps nobody.
 * - `disabled`:  assignment already happened normally at creation.
 */
export const shouldReleaseToHumanOnBotEnd = (
  botMode: BotMode,
  reason: BotEndReason,
): boolean => {
  if (botMode === 'bot_first') return true;
  if (botMode === 'bot_only') return reason === 'no_flow_bound';
  return false;
};
