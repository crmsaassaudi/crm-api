import {
  advanceOccurrence,
  normaliseRecurrence,
  TaskRecurrenceViolation,
} from './task-recurrence';

const DUE = new Date('2026-09-04T09:00:00Z');

describe('advanceOccurrence', () => {
  it('should advance by day/week/month/year', () => {
    expect(advanceOccurrence(DUE, 'daily', 3)).toEqual(
      new Date('2026-09-07T09:00:00Z'),
    );
    expect(advanceOccurrence(DUE, 'weekly', 2)).toEqual(
      new Date('2026-09-18T09:00:00Z'),
    );
    expect(advanceOccurrence(DUE, 'monthly', 1)).toEqual(
      new Date('2026-10-04T09:00:00Z'),
    );
    expect(advanceOccurrence(DUE, 'yearly', 1)).toEqual(
      new Date('2027-09-04T09:00:00Z'),
    );
  });

  it('should clamp a month step to the end of a shorter month', () => {
    // date-fns behaviour, pinned because "monthly on the 31st" is a real
    // configuration and silently skipping February would drop an occurrence.
    expect(
      advanceOccurrence(new Date('2026-01-31T09:00:00Z'), 'monthly', 1),
    ).toEqual(new Date('2026-02-28T09:00:00Z'));
  });
});

describe('normaliseRecurrence', () => {
  it('should do nothing when the payload does not mention recurrence', () => {
    expect(
      normaliseRecurrence({ isRecurring: true }, { dueDate: DUE }),
    ).toEqual({});
  });

  it('should seed nextOccurrenceAt from dueDate on creation', () => {
    // The scheduler selects on `nextOccurrenceAt`. Leaving it unset is why a
    // recurring task recurred zero times.
    const effects = normaliseRecurrence(
      {},
      { isRecurring: true, recurrenceRule: 'weekly', dueDate: DUE },
    );
    expect(effects).toEqual({
      isRecurring: true,
      recurrenceRule: 'weekly',
      recurrenceInterval: 1,
      nextOccurrenceAt: DUE,
    });
  });

  it('should NOT rewind an in-flight cursor when only the interval changes', () => {
    // A template that has already spawned three occurrences must not be reset to
    // its original due date — that would re-spawn everything from the past.
    const inFlight = new Date('2026-11-01T09:00:00Z');
    const effects = normaliseRecurrence(
      {
        isRecurring: true,
        recurrenceRule: 'weekly',
        dueDate: DUE,
        nextOccurrenceAt: inFlight,
      },
      { recurrenceInterval: 3 },
    );
    expect(effects.nextOccurrenceAt).toEqual(inFlight);
    expect(effects.recurrenceInterval).toBe(3);
  });

  it('should clear the cursor when recurrence is switched off', () => {
    // Leaving a stale cursor behind would let the template resume from a past date
    // the moment anyone flipped the flag back, spawning a burst of backdated tasks.
    const effects = normaliseRecurrence(
      {
        isRecurring: true,
        recurrenceRule: 'weekly',
        nextOccurrenceAt: DUE,
      },
      { isRecurring: false },
    );
    expect(effects).toEqual({ isRecurring: false, nextOccurrenceAt: null });
  });

  it('should refuse recurrence with no rule', () => {
    expect(() =>
      normaliseRecurrence({}, { isRecurring: true, dueDate: DUE }),
    ).toThrow(TaskRecurrenceViolation);
  });

  it("should refuse rule 'none' with recurrence on", () => {
    expect(() =>
      normaliseRecurrence(
        {},
        { isRecurring: true, recurrenceRule: 'none', dueDate: DUE },
      ),
    ).toThrow(/chu kỳ/);
  });

  it('should refuse recurrence with no due date to anchor the first occurrence', () => {
    expect(() =>
      normaliseRecurrence({}, { isRecurring: true, recurrenceRule: 'daily' }),
    ).toThrow(/hạn hoàn thành/);
  });

  it('should refuse a non-integer or zero interval', () => {
    for (const interval of [0, -1, 1.5]) {
      expect(() =>
        normaliseRecurrence(
          {},
          {
            isRecurring: true,
            recurrenceRule: 'daily',
            recurrenceInterval: interval,
            dueDate: DUE,
          },
        ),
      ).toThrow(TaskRecurrenceViolation);
    }
  });

  it('should refuse an end date before the first occurrence', () => {
    // Otherwise the template is created already expired: it would never spawn
    // anything and would look like a broken feature rather than a bad input.
    expect(() =>
      normaliseRecurrence(
        {},
        {
          isRecurring: true,
          recurrenceRule: 'weekly',
          dueDate: DUE,
          recurrenceEndsAt: new Date('2026-08-01T00:00:00Z'),
        },
      ),
    ).toThrow(/kết thúc/);
  });

  it('should accept an end date after the first occurrence', () => {
    expect(() =>
      normaliseRecurrence(
        {},
        {
          isRecurring: true,
          recurrenceRule: 'weekly',
          dueDate: DUE,
          recurrenceEndsAt: new Date('2027-01-01T00:00:00Z'),
        },
      ),
    ).not.toThrow();
  });

  it('should inherit the existing rule when only the interval is changed', () => {
    const effects = normaliseRecurrence(
      { isRecurring: true, recurrenceRule: 'monthly', dueDate: DUE },
      { recurrenceInterval: 2 },
    );
    expect(effects.recurrenceRule).toBe('monthly');
  });
});
