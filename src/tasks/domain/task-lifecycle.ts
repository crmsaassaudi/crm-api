/**
 * The business rules of a task's life, expressed without Nest or Mongoose.
 *
 * Deliberately dependency-free so it can be unit-tested without a database or a
 * DI container — the module previously had exactly one spec, covering export
 * queueing, and none of the rules below existed anywhere to be tested.
 *
 * Rules are stated in terms of a status's *properties* (`isTerminal`), never its
 * name. Statuses are tenant-configurable rows in `task_statuses`, so a tenant
 * renaming "Completed" to "Xong" or adding "Cancelled" must not break the
 * invariants. This is why there is no hardcoded state list here: the states are
 * the tenant's, the rules are ours.
 */

export class TaskLifecycleViolation extends Error {
  constructor(
    message: string,
    readonly field: string,
  ) {
    super(message);
    this.name = 'TaskLifecycleViolation';
  }
}

export interface TaskStatusFacts {
  isTerminal: boolean;
}

export interface TaskLifecycleCurrent {
  statusId?: string | null;
  completedAt?: Date | null;
  createdAt?: Date | null;
  dueDate?: Date | null;
  reminderAt?: Date | null;
}

export interface TaskLifecycleChange {
  statusId?: string | null;
  completedAt?: Date | null;
  dueDate?: Date | null;
  reminderAt?: Date | null;
}

/**
 * Fields the caller must merge into the update, on top of what it already sends.
 *
 * `completedAt: null` is meaningful and distinct from absent — it means "clear
 * this", which is what reopening a task has to do.
 */
export interface TaskLifecycleEffects {
  completedAt?: Date | null;
}

const asDate = (value: unknown): Date | null => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
};

/**
 * Decide `completedAt` from the status transition, and refuse date combinations
 * that no report could interpret.
 *
 * Called for both create and update. On create, pass an empty `current`.
 *
 * The behaviour it replaces was an empty `if` block in `TasksService.update`
 * whose comment read "let the frontend decide" — so the moment a task counted as
 * finished was chosen by a browser, and every cycle-time report was built on a
 * value any client could set to anything.
 */
export function applyLifecycle(
  current: TaskLifecycleCurrent,
  change: TaskLifecycleChange,
  statuses: ReadonlyMap<string, TaskStatusFacts>,
  now: Date = new Date(),
): TaskLifecycleEffects {
  const effects: TaskLifecycleEffects = {};

  const currentStatusId = current.statusId ? String(current.statusId) : null;
  const nextStatusId =
    change.statusId !== undefined
      ? change.statusId
        ? String(change.statusId)
        : null
      : currentStatusId;

  const wasTerminal = currentStatusId
    ? statuses.get(currentStatusId)?.isTerminal === true
    : false;
  const isTerminal = nextStatusId
    ? statuses.get(nextStatusId)?.isTerminal === true
    : false;

  // A status id that resolves to nothing is a dangling reference, and the caller
  // is about to persist it. Refusing is the only way `isTerminal` stays
  // meaningful — treating an unknown status as non-terminal would let a deleted
  // status quietly reopen every task that used it.
  if (change.statusId && !statuses.has(String(change.statusId))) {
    throw new TaskLifecycleViolation(
      'Trạng thái không tồn tại trong tenant này.',
      'statusId',
    );
  }

  const explicitCompletedAt =
    change.completedAt !== undefined ? asDate(change.completedAt) : undefined;

  if (!wasTerminal && isTerminal) {
    // Entering a terminal status stamps the completion. An explicitly supplied
    // value is honoured (a backdated import, a user correcting the time) but
    // still has to pass the coherence checks below.
    effects.completedAt = explicitCompletedAt ?? now;
  } else if (wasTerminal && !isTerminal) {
    // Reopening. Clearing `completedAt` is the whole point: leaving it set is
    // what made "completed on time" reports uninterpretable, because a task
    // could be open and carry a completion date at the same time.
    effects.completedAt = null;
  } else if (explicitCompletedAt !== undefined) {
    effects.completedAt = explicitCompletedAt;
  }

  const resultingCompletedAt =
    effects.completedAt !== undefined
      ? effects.completedAt
      : asDate(current.completedAt);

  const createdAt = asDate(current.createdAt);
  if (resultingCompletedAt && createdAt && resultingCompletedAt < createdAt) {
    throw new TaskLifecycleViolation(
      'Thời điểm hoàn thành không thể sớm hơn thời điểm tạo task.',
      'completedAt',
    );
  }

  const dueDate =
    change.dueDate !== undefined
      ? asDate(change.dueDate)
      : asDate(current.dueDate);
  const reminderAt =
    change.reminderAt !== undefined
      ? asDate(change.reminderAt)
      : asDate(current.reminderAt);

  if (reminderAt && dueDate && reminderAt > dueDate) {
    throw new TaskLifecycleViolation(
      'Thời điểm nhắc không thể sau hạn hoàn thành.',
      'reminderAt',
    );
  }

  return effects;
}

/**
 * Whether a task in a terminal status may still be edited, and how much.
 *
 * Terminal tasks are not frozen — a typo in the title of a finished task should
 * be fixable, and reopening must stay possible. What is refused is silently
 * rewriting the *outcome* of finished work: moving its due date or reassigning
 * it while it stays closed. Those are the fields reports aggregate.
 */
const FIELDS_LOCKED_WHILE_TERMINAL = ['dueDate', 'ownerId'] as const;

export function assertTerminalEditAllowed(
  current: TaskLifecycleCurrent,
  change: Record<string, unknown>,
  statuses: ReadonlyMap<string, TaskStatusFacts>,
): void {
  const currentStatusId = current.statusId ? String(current.statusId) : null;
  const wasTerminal = currentStatusId
    ? statuses.get(currentStatusId)?.isTerminal === true
    : false;
  if (!wasTerminal) return;

  // Leaving the terminal status in the same request lifts the restriction: the
  // task is being reopened, and reopening plus rescheduling is one coherent
  // action a user takes on purpose.
  const leavingTerminal =
    change.statusId !== undefined &&
    (!change.statusId ||
      statuses.get(String(change.statusId))?.isTerminal !== true);
  if (leavingTerminal) return;

  for (const field of FIELDS_LOCKED_WHILE_TERMINAL) {
    if (change[field] !== undefined) {
      throw new TaskLifecycleViolation(
        `Không thể thay đổi "${field}" của task đã hoàn thành. Hãy mở lại task trước.`,
        field,
      );
    }
  }
}
