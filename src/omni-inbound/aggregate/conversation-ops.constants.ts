/** Queue name for the conversation-ops aggregate processing queue. */
export const CONV_OPS_QUEUE = 'conversation-ops';

/** Queue name for the dead-letter queue capturing failed conversation ops. */
export const CONV_OPS_DLQ = 'conversation-ops-dlq';

/** Redis key prefix for per-conversation distributed locks. */
export const CONV_OPS_LOCK_PREFIX = 'conv-ops-lock:';

/** TTL (ms) for the per-conversation lock. Should exceed max expected processing time. */
export const CONV_OPS_LOCK_TTL_MS = 15_000;

/** Max retry attempts before moving a job to the DLQ. */
export const CONV_OPS_MAX_ATTEMPTS = 3;

/** Event name emitted by BotCallbackController for bot-generated replies. */
export const BOT_GENERATED_REPLY_EVENT = 'bot.generated_reply';
