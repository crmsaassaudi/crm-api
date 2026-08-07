import { ConfigurableObject } from './object-registry';

/**
 * Which payload fields a list view may be sorted by, per object.
 *
 * One list, three consumers: the query DTOs validate against it, the
 * repositories resolve a sort field from it, and `/me/object-config` publishes
 * it so the browser only draws a sort control where the server will honour it.
 *
 * Before this existed the browser drew no sort control at all, and the two APIs
 * that did accept `sortBy` — tickets and accounts — silently fell back to
 * `createdAt` for anything outside their private whitelist. Both failure modes
 * are the same one: a list that claims an order it is not in.
 *
 * The membership rule is not negotiable and is enforced by
 * `sortable-fields.spec.ts`: a field belongs here only when a compound index
 * `{ tenantId, <field>, _id }` exists in that object's schema. Sorting an
 * unindexed field is an in-memory sort that dies at Mongo's 32MB limit — the
 * biggest tenant hits it first, and it fails outright rather than degrading.
 */
export const SORTABLE_FIELDS: Record<ConfigurableObject, readonly string[]> = {
  Contact: [
    'createdAt',
    'updatedAt',
    // `name` is the contact list's primary column and is concatenated by the
    // mapper rather than stored, so it sorts through `firstName` — see
    // SORT_FIELD_STORAGE. Without it the one column every user reaches for
    // first was the one column with no sort.
    'name',
    'firstName',
    'lastName',
    'score',
    'lastActivityAt',
    'totalRevenue',
    'lastPurchaseAt',
  ],
  // `industry` is gone: it is a picklist, so ordering by it groups rather than
  // ranks, and it was the one entry here that never had an index.
  Account: [
    'createdAt',
    'updatedAt',
    'name',
    'annualRevenue',
    'numberOfEmployees',
  ],
  // `value` and `closeDate` are what a sales list is actually read for —
  // "biggest deals" and "closing this month" — and neither was expressible.
  Deal: ['createdAt', 'updatedAt', 'value', 'closeDate'],
  Ticket: ['createdAt', 'updatedAt', 'ticketNumber'],
  // `title` stays out until it has an index. See task.schema.ts.
  Task: ['createdAt', 'dueDate'],
};

/**
 * Payload keys whose sort has to run against a different stored path.
 *
 * Only for derived fields — ones the mapper composes and the document does not
 * hold. Keeping the translation here rather than in the repository means the
 * index check below tests the path Mongo will actually use.
 */
export const SORT_FIELD_STORAGE: Partial<
  Record<ConfigurableObject, Readonly<Record<string, string>>>
> = {
  Contact: { name: 'firstName' },
};

/** The document path a sort on `field` resolves to. */
export const storagePathForSort = (
  object: ConfigurableObject,
  field: string,
): string => SORT_FIELD_STORAGE[object]?.[field] ?? field;

export const isSortableField = (
  object: ConfigurableObject,
  field: string,
): boolean => SORTABLE_FIELDS[object].includes(field);
