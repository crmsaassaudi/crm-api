export const TICKET_ERRORS = {
  NOT_FOUND: 'TICKET_NOT_FOUND',
} as const;

export type TicketErrorCode =
  (typeof TICKET_ERRORS)[keyof typeof TICKET_ERRORS];
