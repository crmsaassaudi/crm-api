/**
 * Ticket lifecycle events.
 *
 * One file holding both the names and their payload types, because the failure
 * this module has already suffered twice is a producer and a consumer agreeing
 * on a concept and disagreeing on a string. A listener bound to a name nobody
 * emits does not fail — it simply never runs, which is how ticket
 * auto-assignment came to be dead for every tenant while looking wired up.
 *
 * `ticket.created` is deliberately absent: `EntityAuditService` already emits
 * it as `<entity>.<kind>` and `RecordAutoAssignmentListener` already consumes
 * it. Redeclaring it here would create the second name this file exists to
 * prevent.
 */
export const TicketEvents = {
  /** A status transition committed. Carries the SLA-relevant status flags. */
  STATUS_CHANGED: 'ticket.status.changed',
  /** An agent posted the first public reply. */
  FIRST_RESPONDED: 'ticket.first_responded',
  /** A public reply was posted (any, including the first). */
  REPLIED: 'ticket.replied',
  /** The customer answered on the linked conversation after a reply. */
  CUSTOMER_REPLIED: 'ticket.customer_replied',
} as const;

export interface TicketStatusSnapshot {
  id: string;
  label: string;
  isTerminal: boolean;
  terminalKind?: 'resolved' | 'closed' | null;
  pausesSla: boolean;
}

/** What `applyStatusTransition` decided, handed to the listeners unchanged. */
export interface TicketStatusTransition {
  previousStatus: Omit<TicketStatusSnapshot, 'terminalKind'> | null;
  nextStatus: TicketStatusSnapshot;
  isReopen: boolean;
}

export interface TicketStatusChangedEvent extends TicketStatusTransition {
  tenantId: string;
  ticketId: string;
  actorId: string | null;
}

export interface TicketRepliedEvent {
  tenantId: string;
  ticketId: string;
  messageId: string;
  authorId: string | null;
  respondedAt: Date;
}
