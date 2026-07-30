/** Queue name for the conversation-ops aggregate processing queue. */
export const CONV_OPS_QUEUE = 'conversation-ops';

/** Queue name for the dead-letter queue capturing failed conversation ops. */
export const CONV_OPS_DLQ = 'conversation-ops-dlq';

/** Redis key prefix for per-conversation distributed locks. */
export const CONV_OPS_LOCK_PREFIX = 'conv-ops-lock:';

/** TTL (ms) for the per-conversation lock. */
export const CONV_OPS_LOCK_TTL_MS = 15_000;

/** Max retry attempts before moving a job to the DLQ. */
export const CONV_OPS_MAX_ATTEMPTS = 3;

/** Event name emitted by BotCallbackController for bot-generated replies. */
export const BOT_GENERATED_REPLY_EVENT = 'bot.generated_reply';

/** TTL (seconds) for Redis idempotency keys. */
export const IDEM_KEY_TTL_SEC = 3600;

/** Max characters for message preview in conversation aggregate. */
export const PREVIEW_MAX_LENGTH = 200;

/** TTL (seconds) for presigned S3 media URLs. */
export const PRESIGNED_URL_TTL_SEC = 3600;

/** Operations slower than this (ms) trigger a warning log. */
export const SLOW_OP_THRESHOLD_MS = 5_000;

/**
 * DI token for ConversationOpsProcessor.
 *
 * ConversationCommandService needs the processor for inline execution, but a
 * static `import { ConversationOpsProcessor }` there closes a runtime require
 * cycle:
 *
 *   command.service -> ops.processor -> assignment.service
 *      -> work-distribution.service -> command.service
 *
 * Every cycle in this component runs through that one edge, and it crashed the
 * API at boot with "Cannot access 'AssignmentService' before initialization":
 * `emitDecoratorMetadata` evaluates the imported class at module scope, while
 * the other module is still initialising. `forwardRef` does not help — the
 * metadata reference is emitted regardless.
 *
 * Injecting by token lets the command service import the processor as a *type
 * only*, which erases the edge at runtime.
 */
export const CONVERSATION_OPS_PROCESSOR = Symbol('ConversationOpsProcessor');
