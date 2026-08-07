import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Pins the ordering that makes the outbox durable without a transaction.
 *
 * `ConversationOpsProcessor` writes the aggregate, then the outbox row, then
 * marks the operation complete. Only the last step is what stops a retry, so a
 * crash anywhere before it is recovered by BullMQ re-running the handler.
 *
 * Move `completeOperation` above the outbox write — a plausible tidy-up, since
 * it reads like "we're done with the command now" — and the recovery path
 * disappears: the retry would see `completedAt` and skip, and the event would
 * be lost for good. Nothing else in the codebase would fail.
 *
 * Checked as source text rather than by driving the processor, because the
 * property is *where the call sits*, not what it returns. A behavioural test
 * would need a real crash between two awaits to observe the difference.
 */
const SOURCE = readFileSync(
  join(__dirname, 'conversation-ops.processor.ts'),
  'utf8',
);

describe('conversation-ops outbox durability', () => {
  it('should mark the operation complete only after the dispatch that writes the outbox', () => {
    // Position in the file is not execution order — the handler methods are
    // defined below `handleCommand`, so comparing raw offsets against the
    // outbox call sites proves nothing. What can be checked textually, and is
    // the property that matters, is the order *within* `handleCommand`: every
    // handler runs from the dispatch switch, and `completeOperation` comes
    // after it.
    const dispatch = SOURCE.indexOf('switch (cmd.type) {');
    const complete = SOURCE.indexOf('await this.completeOperation(');

    expect(dispatch).toBeGreaterThan(-1);
    expect(complete).toBeGreaterThan(dispatch);

    // And it is the only call site, so there is no second path that completes
    // the operation early.
    expect(SOURCE.split('await this.completeOperation(')).toHaveLength(2);
  });

  it('should short-circuit a retry only on completedAt, never on the row existing', () => {
    // `claimOperation` inserts the `processed_operations` row *before* doing
    // any work. If a retry treated the row's mere existence as "already done",
    // every crash mid-handler would be unrecoverable — the row is written
    // first precisely so it can carry the sequence number.
    expect(SOURCE).toContain('if (winner?.completedAt) return null;');
  });

  it('should keep the outbox write out of any transaction, deliberately', () => {
    // Stated so the next reader does not "fix" the missing session. Adding one
    // would mean threading it through every repository call the handlers make;
    // the job retry already provides at-least-once, and the schema docblock
    // explains why.
    const outboxCreate = SOURCE.slice(
      SOURCE.indexOf('this.outboxModel.create('),
      SOURCE.indexOf('this.outboxModel.create(') + 300,
    );
    expect(outboxCreate).not.toContain('session');
  });
});
