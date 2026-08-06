/**
 * Physical MongoDB collection names.
 *
 * Anything that reaches a collection *by name* — raw driver reads, aggregation
 * `$lookup`, import reference resolution — must read it from here rather than
 * spelling it inline. Those call sites bypass Mongoose, so a misspelling does
 * not throw: `$lookup` yields an empty array and the resolver caches nothing.
 *
 * That is not hypothetical. The ticket import declared `tickettypes` /
 * `ticketstatuses` / `ticketsources` and the ticket report `$lookup`-ed the same
 * three names, while the schemas declare `ticket_types` / `ticket_statuses` /
 * `ticket_sources`. Every ticket import failed on a required reference, and the
 * report's `$ifNull` fallback quietly relabelled every ticket in the tenant as
 * "open". Both layers were wrong in the same way for the same reason: the name
 * was written twice and verified nowhere.
 *
 * `collections.spec.ts` asserts each value here matches the `collection` option
 * of the schema that owns it, so a rename cannot drift again.
 */
export const COLLECTIONS = {
  accounts: 'accounts',
  accountStatuses: 'account_statuses',
  accountTypes: 'account_types',
  activityLogs: 'activity_logs',
  auditLogs: 'audit_logs',
  contacts: 'contacts',
  deals: 'deals',
  dealSources: 'deal_sources',
  dealStages: 'deal_stages',
  groups: 'groups',
  slaPolicies: 'sla_policies',
  tasks: 'tasks',
  tickets: 'tickets',
  ticketMessages: 'ticket_messages',
  ticketResolutionCodes: 'ticket_resolution_codes',
  ticketSources: 'ticket_sources',
  ticketStatuses: 'ticket_statuses',
  ticketTypes: 'ticket_types',
  users: 'users',
} as const;

export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];
