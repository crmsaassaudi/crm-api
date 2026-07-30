export const CONVERSATION_STATUSES = [
  'open',
  'pending',
  'resolved',
  'closed',
] as const;

export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

/**
 * Closed is terminal. Resolved is the only completed state that can be
 * reopened; a new customer message on a closed provider thread starts a new
 * support session instead.
 */
const ALLOWED_TRANSITIONS: Record<
  ConversationStatus,
  ReadonlySet<ConversationStatus>
> = {
  open: new Set(['pending', 'resolved', 'closed']),
  pending: new Set(['open', 'resolved', 'closed']),
  resolved: new Set(['open', 'closed']),
  closed: new Set(),
};

export function isConversationStatus(
  value: unknown,
): value is ConversationStatus {
  return (
    typeof value === 'string' &&
    CONVERSATION_STATUSES.includes(value as ConversationStatus)
  );
}

export function canTransitionConversationStatus(
  current: ConversationStatus,
  next: ConversationStatus,
): boolean {
  return current === next || ALLOWED_TRANSITIONS[current].has(next);
}

export function assertConversationStatusTransition(
  current: ConversationStatus,
  next: ConversationStatus,
): void {
  if (!canTransitionConversationStatus(current, next)) {
    throw new InvalidConversationStatusTransitionError(current, next);
  }
}

export class InvalidConversationStatusTransitionError extends Error {
  readonly code = 'INVALID_CONVERSATION_STATUS_TRANSITION';

  constructor(
    readonly current: ConversationStatus,
    readonly next: ConversationStatus,
  ) {
    super(`Conversation status cannot transition from ${current} to ${next}`);
    this.name = 'InvalidConversationStatusTransitionError';
  }
}
