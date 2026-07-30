import {
  EntityReference,
  mergeReferences,
} from '../common/references/entity-reference';

/**
 * Every place in the database that references a Ticket.
 *
 * `TicketsService.mergeTickets` re-parents `activity_logs` and `tasks` by hand today; this
 * registry is the declaration those queries should eventually read from, and is what the
 * purge does read.
 */
export const TICKET_REFERENCES: readonly EntityReference[] = [
  {
    collection: 'tickets',
    field: 'parentTicketId',
    kind: 'objectId',
    label: 'child tickets',
    onMerge: 'reparent',
    // Children are promoted to top level, never deleted. A sub-ticket is a real support
    // case with its own SLA and its own customer waiting on it — purging the parent must
    // not take it down.
    onPurge: 'detach',
  },
  {
    collection: 'tasks',
    field: 'relatedTo',
    kind: 'relatedTo',
    discriminator: { field: 'type', value: 'Ticket' },
    label: 'tasks',
    onMerge: 'reparent',
    onPurge: 'detach',
  },
  {
    collection: 'activity_logs',
    field: 'targetId',
    kind: 'discriminatedString',
    // Lower-case here, `'Deal'` capitalised in the deal registry: that is what each
    // domain writes, and the registry's job is to match reality rather than tidy it.
    discriminator: { field: 'targetType', value: 'ticket' },
    label: 'timeline entries',
    onMerge: 'reparent',
    onPurge: 'cascade',
  },
  {
    collection: 'interaction_segments',
    field: 'refId',
    kind: 'discriminatedString',
    discriminator: { field: 'type', value: 'ticket' },
    label: 'agent time segments',
    onMerge: 'reparent',
    // KEEP, deliberately. These are minutes an agent actually worked, and they feed
    // occupancy and workforce reporting. Deleting them would rewrite a person's recorded
    // working time because a ticket aged out of retention; detaching would leave the
    // segment with no way to be attributed at all. The dangling `refId` is acceptable
    // because nothing navigates from a segment back to the ticket — it is a measurement,
    // not a link.
    onPurge: 'keep',
  },
  {
    collection: 'audit_logs',
    field: 'entityId',
    kind: 'discriminatedString',
    discriminator: { field: 'entityType', value: 'TICKET' },
    label: 'audit entries',
    onMerge: 'keep',
    onPurge: 'keep',
  },
] as const;

/** References a merge must move onto the surviving ticket. */
export const TICKET_MERGE_REFERENCES = mergeReferences(TICKET_REFERENCES);
