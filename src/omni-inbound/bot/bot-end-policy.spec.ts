import { shouldReleaseToHumanOnBotEnd } from './bot-end-policy';

describe('shouldReleaseToHumanOnBotEnd', () => {
  it('should release a bot_first conversation whichever way the bot ended', () => {
    // Regression guard: bot_first defers auto-assignment, so a bot that ends
    // without handing off used to strand the conversation with no bot and no
    // agent — and the customer's next message was silently skipped.
    expect(shouldReleaseToHumanOnBotEnd('bot_first', 'flow_completed')).toBe(
      true,
    );
    expect(shouldReleaseToHumanOnBotEnd('bot_first', 'no_flow_bound')).toBe(
      true,
    );
  });

  it('should keep bot_only conversations away from agents when a flow ran', () => {
    expect(shouldReleaseToHumanOnBotEnd('bot_only', 'flow_completed')).toBe(
      false,
    );
  });

  it('should still release a bot_only conversation when no flow is bound', () => {
    // There is no bot to speak of — stranding the conversation helps nobody.
    expect(shouldReleaseToHumanOnBotEnd('bot_only', 'no_flow_bound')).toBe(
      true,
    );
  });

  it('should do nothing when the bot is disabled — assignment already happened', () => {
    expect(shouldReleaseToHumanOnBotEnd('disabled', 'flow_completed')).toBe(
      false,
    );
    expect(shouldReleaseToHumanOnBotEnd('disabled', 'no_flow_bound')).toBe(
      false,
    );
  });
});
