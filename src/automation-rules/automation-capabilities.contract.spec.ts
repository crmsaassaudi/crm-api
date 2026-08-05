import {
  AUTOMATION_ACTION_TYPES,
  resolveJobNameForAction,
  resolveQueueForAction,
} from './queue/automation-queue.constants';
import { AutomationWorkflowController } from './automation-workflow.controller';
import { AUTOMATION_TRIGGER_EVENTS } from './domain/trigger-catalog';
import * as executors from './engine/executors';

/**
 * The engine's vocabulary is one list, not five.
 *
 * Executors, queue routing, save-time validation and the builder palette all
 * derive from `AUTOMATION_ACTION_TYPES` / `AUTOMATION_TRIGGER_EVENTS`. These
 * assertions keep that true: a hand-kept second copy drifts, and the drift stays
 * invisible until a user picks the option that does not work.
 */
describe('automation capability contract', () => {
  /**
   * Executor classes are instantiated with no dependencies purely to read their
   * `actionType` field. Their constructors only assign parameter properties, so
   * nothing runs.
   */
  const executorActionTypes = Object.values(
    executors as Record<string, unknown>,
  )
    .map((exported) => {
      if (typeof exported !== 'function') return undefined;
      try {
        const Ctor = exported as new () => { actionType?: unknown };
        return new Ctor().actionType;
      } catch {
        return undefined;
      }
    })
    .filter(
      (actionType): actionType is string => typeof actionType === 'string',
    );

  it('should have exactly one executor per action type, and no executor without one', () => {
    expect([...executorActionTypes].sort()).toEqual(
      [...AUTOMATION_ACTION_TYPES].sort(),
    );
  });

  it('should route every action type to a queue and a job name', () => {
    for (const actionType of AUTOMATION_ACTION_TYPES) {
      expect(() => resolveQueueForAction(actionType)).not.toThrow();
      expect(() => resolveJobNameForAction(actionType)).not.toThrow();
    }
  });

  it('should throw on an unknown action type rather than defaulting', () => {
    // The previous mapping fell back to `update_field`, so a typo produced a job
    // labelled as a field update that no executor could handle.
    expect(() => resolveQueueForAction('exfiltrate_everything')).toThrow(
      /Unknown automation actionType/,
    );
    expect(() => resolveJobNameForAction('exfiltrate_everything')).toThrow(
      /Unknown automation actionType/,
    );
  });

  describe('the capabilities endpoint the builder reads', () => {
    const capabilities = new AutomationWorkflowController(
      {} as any,
      {} as any,
    ).capabilities();

    it('should publish the same action list the engine executes', () => {
      expect([...capabilities.actionTypes].sort()).toEqual(
        [...AUTOMATION_ACTION_TYPES].sort(),
      );
    });

    it('should publish the same trigger events the DTO accepts', () => {
      expect(capabilities.triggerEvents).toEqual(AUTOMATION_TRIGGER_EVENTS);
    });

    it('should only annotate actions that exist', () => {
      for (const actionType of [
        ...capabilities.crmOnlyActions,
        ...capabilities.configRequiredActions,
      ]) {
        expect(AUTOMATION_ACTION_TYPES).toContain(actionType as any);
      }
    });

    it('should list Conversation and Message as authorable trigger objects', () => {
      // The bridge re-emits their events and the executors handle them; only the
      // schema enum kept them unusable.
      expect(capabilities.triggerObjects).toContain('Conversation');
      expect(capabilities.triggerObjects).toContain('Message');
    });
  });
});
