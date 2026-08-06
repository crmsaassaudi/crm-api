export const TICKET_ERRORS = {
  NOT_FOUND: 'TICKET_NOT_FOUND',
  /**
   * Leaving a terminal status without `allowReopen`.
   *
   * A distinct code, and a 409 rather than a 400, because the client is meant
   * to act on it: the ticket UI turns this into a "Reopen this ticket?"
   * confirmation and retries. A generic 400 was indistinguishable from a
   * malformed payload, so the web never handled it and the agent saw a success
   * toast over a rejected write.
   */
  REOPEN_NOT_CONFIRMED: 'TICKET_REOPEN_NOT_CONFIRMED',
  /** A ticket write lost an optimistic-concurrency race with another agent. */
  VERSION_CONFLICT: 'TICKET_VERSION_CONFLICT',
} as const;

export type TicketErrorCode =
  (typeof TICKET_ERRORS)[keyof typeof TICKET_ERRORS];
