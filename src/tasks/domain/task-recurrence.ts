import { addDays, addWeeks, addMonths, addYears } from 'date-fns';
import { TaskRecurrenceRule } from '../tasks.constants';

export class TaskRecurrenceViolation extends Error {
  constructor(
    message: string,
    readonly field: string,
  ) {
    super(message);
    this.name = 'TaskRecurrenceViolation';
  }
}

export interface RecurrenceInput {
  isRecurring?: boolean;
  recurrenceRule?: TaskRecurrenceRule;
  recurrenceInterval?: number;
  recurrenceEndsAt?: Date | null;
  dueDate?: Date | null;
  nextOccurrenceAt?: Date | null;
}

export interface RecurrenceEffects {
  isRecurring?: boolean;
  recurrenceRule?: TaskRecurrenceRule;
  recurrenceInterval?: number;
  nextOccurrenceAt?: Date | null;
}

export function advanceOccurrence(
  from: Date,
  rule: TaskRecurrenceRule | undefined,
  interval: number,
): Date {
  switch (rule) {
    case 'daily':
      return addDays(from, interval);
    case 'weekly':
      return addWeeks(from, interval);
    case 'monthly':
      return addMonths(from, interval);
    case 'yearly':
      return addYears(from, interval);
    default:
      return addDays(from, interval);
  }
}

export function normaliseRecurrence(
  current: RecurrenceInput,
  change: RecurrenceInput,
): RecurrenceEffects {
  const touchesRecurrence =
    change.isRecurring !== undefined ||
    change.recurrenceRule !== undefined ||
    change.recurrenceInterval !== undefined ||
    change.recurrenceEndsAt !== undefined;

  if (!touchesRecurrence) return {};

  const isRecurring =
    change.isRecurring !== undefined
      ? change.isRecurring
      : current.isRecurring === true;

  if (!isRecurring) {
    return { isRecurring: false, nextOccurrenceAt: null };
  }

  const rule =
    change.recurrenceRule ?? current.recurrenceRule ?? ('none' as const);
  if (rule === 'none') {
    throw new TaskRecurrenceViolation(
      'Task lặp lại phải có chu kỳ (daily/weekly/monthly/yearly).',
      'recurrenceRule',
    );
  }

  const interval = change.recurrenceInterval ?? current.recurrenceInterval ?? 1;
  if (!Number.isInteger(interval) || interval < 1) {
    throw new TaskRecurrenceViolation(
      'Khoảng lặp phải là số nguyên ≥ 1.',
      'recurrenceInterval',
    );
  }

  const anchor = change.dueDate ?? current.dueDate ?? null;
  if (!anchor) {
    throw new TaskRecurrenceViolation(
      'Task lặp lại cần hạn hoàn thành để tính lần phát sinh đầu tiên.',
      'dueDate',
    );
  }

  const endsAt = change.recurrenceEndsAt ?? current.recurrenceEndsAt ?? null;
  const firstOccurrence = new Date(anchor);
  if (endsAt && firstOccurrence > new Date(endsAt)) {
    throw new TaskRecurrenceViolation(
      'Ngày kết thúc lặp lại phải sau lần phát sinh đầu tiên.',
      'recurrenceEndsAt',
    );
  }

  return {
    isRecurring: true,
    recurrenceRule: rule,
    recurrenceInterval: interval,
    nextOccurrenceAt: current.nextOccurrenceAt ?? firstOccurrence,
  };
}
