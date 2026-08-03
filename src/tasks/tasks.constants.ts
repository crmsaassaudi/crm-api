export const TASK_EXPORT_QUEUE = 'task-export';

/**
 * Redis pub/sub channel carrying due task reminders.
 *
 * Named to match the `socket:*` convention CrmRealtimeGateway bridges into
 * Socket.IO tenant rooms, so reminders travel the same path as export/import
 * completion instead of needing a delivery mechanism of their own.
 */
export const TASK_REMINDER_CHANNEL = 'socket:task:reminder:due';

/**
 * The only priorities a task may carry.
 *
 * Declared once and reused by the DTO (`@IsIn`), the schema (`enum`) and the
 * list filter. It used to be a bare `@IsString()` on the DTO with the allowed
 * values written only in the Swagger example, while the repository upper-cased
 * values when *filtering* but not when *writing* — so 'high' and 'HIGH' both
 * reached the database and each was invisible to a filter for the other.
 */
export const TASK_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const DEFAULT_TASK_PRIORITY: TaskPriority = 'MEDIUM';

/**
 * Largest page the list endpoint will serve.
 *
 * A hard ceiling rather than advice: `findManyWithPagination` hydrates full
 * Mongoose documents and populates four references per row, so `limit` is a
 * direct multiplier on heap. Before this existed the endpoint read
 * `Number(query.limit) || 10` with no upper bound, and a single
 * `?limit=1000000` was enough to OOM a replica — which takes every tenant on
 * that replica with it.
 */
export const TASK_LIST_MAX_LIMIT = 100;
export const TASK_LIST_DEFAULT_LIMIT = 25;

/**
 * Largest number of ids one bulk mutation may touch.
 *
 * Bulk endpoints exist so a 10.000-user tenant can triage without issuing one
 * request per row; the cap keeps that from becoming an unbounded write in a
 * single transaction.
 */
export const TASK_BULK_MAX_IDS = 200;

/** Recurrence rules the scheduler knows how to advance. */
export const TASK_RECURRENCE_RULES = [
  'none',
  'daily',
  'weekly',
  'monthly',
  'yearly',
] as const;
export type TaskRecurrenceRule = (typeof TASK_RECURRENCE_RULES)[number];
