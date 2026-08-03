import {
  applyLifecycle,
  assertTerminalEditAllowed,
  TaskLifecycleViolation,
  TaskStatusFacts,
} from './task-lifecycle';

const OPEN = 'aaaaaaaaaaaaaaaaaaaaaaa1';
const DONE = 'aaaaaaaaaaaaaaaaaaaaaaa2';
const CANCELLED = 'aaaaaaaaaaaaaaaaaaaaaaa3';

const STATUSES: ReadonlyMap<string, TaskStatusFacts> = new Map([
  [OPEN, { isTerminal: false }],
  [DONE, { isTerminal: true }],
  // A second terminal status, because "terminal" is a property a tenant can put
  // on more than one status — the rules must not assume a single "Completed".
  [CANCELLED, { isTerminal: true }],
]);

const NOW = new Date('2026-08-03T12:00:00Z');
const CREATED = new Date('2026-08-01T09:00:00Z');

describe('applyLifecycle', () => {
  describe('completedAt is decided by the server, not the client', () => {
    it('should stamp completedAt when a task enters a terminal status', () => {
      const effects = applyLifecycle(
        { statusId: OPEN, createdAt: CREATED },
        { statusId: DONE },
        STATUSES,
        NOW,
      );
      expect(effects.completedAt).toEqual(NOW);
    });

    it('should stamp completedAt for any terminal status, not just one named Done', () => {
      const effects = applyLifecycle(
        { statusId: OPEN, createdAt: CREATED },
        { statusId: CANCELLED },
        STATUSES,
        NOW,
      );
      expect(effects.completedAt).toEqual(NOW);
    });

    it('should honour an explicitly supplied completedAt on completion', () => {
      const backdated = new Date('2026-08-02T10:00:00Z');
      const effects = applyLifecycle(
        { statusId: OPEN, createdAt: CREATED },
        { statusId: DONE, completedAt: backdated },
        STATUSES,
        NOW,
      );
      expect(effects.completedAt).toEqual(backdated);
    });

    it('should CLEAR completedAt when a task is reopened', () => {
      // The defect this encodes: a reopened task kept its completion date, so it
      // was simultaneously open and completed and every cycle-time metric built
      // on it was wrong.
      const effects = applyLifecycle(
        { statusId: DONE, completedAt: NOW, createdAt: CREATED },
        { statusId: OPEN },
        STATUSES,
        NOW,
      );
      expect(effects.completedAt).toBeNull();
    });

    it('should keep the original completion when moving between two terminal statuses', () => {
      const original = new Date('2026-08-02T08:00:00Z');
      const effects = applyLifecycle(
        { statusId: DONE, completedAt: original, createdAt: CREATED },
        { statusId: CANCELLED },
        STATUSES,
        NOW,
      );
      expect(effects.completedAt).toBeUndefined();
    });

    it('should leave completedAt alone when the status does not change', () => {
      const effects = applyLifecycle(
        { statusId: OPEN, createdAt: CREATED },
        { title: 'renamed' } as any,
        STATUSES,
        NOW,
      );
      expect(effects.completedAt).toBeUndefined();
    });
  });

  describe('date coherence', () => {
    it('should refuse a completedAt earlier than createdAt', () => {
      expect(() =>
        applyLifecycle(
          { statusId: OPEN, createdAt: CREATED },
          { statusId: DONE, completedAt: new Date('2026-07-01T00:00:00Z') },
          STATUSES,
          NOW,
        ),
      ).toThrow(TaskLifecycleViolation);
    });

    it('should refuse a reminder scheduled after the due date', () => {
      expect(() =>
        applyLifecycle(
          { statusId: OPEN, createdAt: CREATED },
          {
            dueDate: new Date('2026-08-10T00:00:00Z'),
            reminderAt: new Date('2026-08-20T00:00:00Z'),
          },
          STATUSES,
          NOW,
        ),
      ).toThrow(/nhắc/);
    });

    it('should check a new reminder against the EXISTING due date', () => {
      // The combination only becomes invalid when the two values are considered
      // together — validating each field in isolation cannot catch it.
      expect(() =>
        applyLifecycle(
          {
            statusId: OPEN,
            createdAt: CREATED,
            dueDate: new Date('2026-08-10T00:00:00Z'),
          },
          { reminderAt: new Date('2026-08-15T00:00:00Z') },
          STATUSES,
          NOW,
        ),
      ).toThrow(TaskLifecycleViolation);
    });

    it('should accept a reminder before the due date', () => {
      expect(() =>
        applyLifecycle(
          { statusId: OPEN, createdAt: CREATED },
          {
            dueDate: new Date('2026-08-20T00:00:00Z'),
            reminderAt: new Date('2026-08-19T00:00:00Z'),
          },
          STATUSES,
          NOW,
        ),
      ).not.toThrow();
    });
  });

  describe('dangling status reference', () => {
    it('should refuse a statusId that no status in the tenant matches', () => {
      // Fail-closed. Treating an unresolvable status as non-terminal would let a
      // deleted status silently reopen every task that referenced it.
      expect(() =>
        applyLifecycle(
          { statusId: OPEN, createdAt: CREATED },
          { statusId: 'bbbbbbbbbbbbbbbbbbbbbbbb' },
          STATUSES,
          NOW,
        ),
      ).toThrow(/không tồn tại/);
    });
  });

  describe('create (no current state)', () => {
    it('should stamp completedAt when a task is created directly in a terminal status', () => {
      const effects = applyLifecycle({}, { statusId: DONE }, STATUSES, NOW);
      expect(effects.completedAt).toEqual(NOW);
    });

    it('should leave completedAt unset for a task created open', () => {
      const effects = applyLifecycle({}, { statusId: OPEN }, STATUSES, NOW);
      expect(effects.completedAt).toBeUndefined();
    });
  });
});

describe('assertTerminalEditAllowed', () => {
  it('should allow editing a non-terminal task freely', () => {
    expect(() =>
      assertTerminalEditAllowed(
        { statusId: OPEN },
        { dueDate: new Date(), ownerId: 'x' },
        STATUSES,
      ),
    ).not.toThrow();
  });

  it('should allow cosmetic edits on a completed task', () => {
    expect(() =>
      assertTerminalEditAllowed(
        { statusId: DONE },
        { title: 'fix a typo', description: 'more detail' },
        STATUSES,
      ),
    ).not.toThrow();
  });

  it('should refuse rescheduling a completed task', () => {
    expect(() =>
      assertTerminalEditAllowed(
        { statusId: DONE },
        { dueDate: new Date('2027-01-01T00:00:00Z') },
        STATUSES,
      ),
    ).toThrow(TaskLifecycleViolation);
  });

  it('should refuse reassigning a completed task', () => {
    expect(() =>
      assertTerminalEditAllowed(
        { statusId: DONE },
        { ownerId: 'u2' },
        STATUSES,
      ),
    ).toThrow(TaskLifecycleViolation);
  });

  it('should allow rescheduling in the SAME request that reopens the task', () => {
    // Reopen-and-reschedule is one deliberate action, not a bypass.
    expect(() =>
      assertTerminalEditAllowed(
        { statusId: DONE },
        { statusId: OPEN, dueDate: new Date('2027-01-01T00:00:00Z') },
        STATUSES,
      ),
    ).not.toThrow();
  });

  it('should still refuse when the request moves to ANOTHER terminal status', () => {
    expect(() =>
      assertTerminalEditAllowed(
        { statusId: DONE },
        { statusId: CANCELLED, dueDate: new Date('2027-01-01T00:00:00Z') },
        STATUSES,
      ),
    ).toThrow(TaskLifecycleViolation);
  });
});
