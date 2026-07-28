import { TriggerEvaluatorService } from './trigger-evaluator.service';
import { AutomationEventPayload } from '../events/automation-event.payload';

/**
 * The matching rules that used to live inline in AutomationEventListenerService.
 */
describe('TriggerEvaluatorService', () => {
  const build = (workflows: any[] = [], throttled = false) => {
    const workflowRepo = {
      findActiveByTrigger: jest.fn().mockResolvedValue(workflows),
    };
    const orchestrator = { execute: jest.fn() };
    const throttle = {
      shouldThrottle: jest.fn().mockResolvedValue({ throttled }),
    };
    const bulkProducer = { dispatch: jest.fn() };
    const executionLogRepo = {
      startExecution: jest.fn().mockResolvedValue({ _id: 'log1' }),
      failExecution: jest.fn(),
    };

    const service = new TriggerEvaluatorService(
      workflowRepo as any,
      orchestrator as any,
      throttle as any,
      bulkProducer as any,
      executionLogRepo as any,
    );
    return {
      service,
      workflowRepo,
      orchestrator,
      bulkProducer,
      executionLogRepo,
    };
  };

  const payload = (
    overrides: Partial<AutomationEventPayload> = {},
  ): AutomationEventPayload => ({
    tenantId: 't1',
    event: 'record_created',
    object: 'Contact',
    recordId: 'c1',
    data: { id: 'c1' },
    ...overrides,
  });

  it('should query workflows by the exact event and object', async () => {
    const { service, workflowRepo } = build();

    await service.evaluate(payload());

    expect(workflowRepo.findActiveByTrigger).toHaveBeenCalledWith(
      't1',
      'record_created',
      'Contact',
    );
  });

  it('should execute each matching workflow', async () => {
    const wf = { _id: 'wf1', name: 'W', version: 3 };
    const { service, orchestrator } = build([wf]);
    const event = payload();

    await service.evaluate(event);

    expect(orchestrator.execute).toHaveBeenCalledWith(wf, event);
  });

  it('should skip the workflow that caused the update (Layer 0 self-trigger)', async () => {
    const wf = { _id: 'wf1', name: 'W' };
    const { service, orchestrator } = build([wf]);

    await service.evaluate(payload({ _automationSourceWorkflowId: 'wf1' }));

    expect(orchestrator.execute).not.toHaveBeenCalled();
  });

  it('should only fire a field-scoped trigger when that field changed', async () => {
    const wf = {
      _id: 'wf1',
      name: 'W',
      publishedTriggerConfig: { field: 'ownerId' },
    };
    const { service, orchestrator } = build([wf]);

    await service.evaluate(
      payload({ event: 'field_updated', changedFields: ['priority'] }),
    );
    expect(orchestrator.execute).not.toHaveBeenCalled();

    await service.evaluate(
      payload({ event: 'field_updated', changedFields: ['ownerId'] }),
    );
    expect(orchestrator.execute).toHaveBeenCalledTimes(1);
  });

  it('should hand the bulk queue a workflow id, not a workflow snapshot', async () => {
    const wf = { _id: 'wf1', name: 'W' };
    const { service, bulkProducer, orchestrator } = build([wf], true);
    const event = payload();

    await service.evaluate(event);

    expect(bulkProducer.dispatch).toHaveBeenCalledWith({
      workflowId: 'wf1',
      payload: event,
    });
    expect(orchestrator.execute).not.toHaveBeenCalled();
  });

  it('should record a failed execution when a workflow throws', async () => {
    const wf = { _id: 'wf1', name: 'W', version: 2 };
    const { service, orchestrator, executionLogRepo } = build([wf]);
    orchestrator.execute.mockRejectedValue(new Error('EXECUTION_TIMEOUT'));

    await service.evaluate(payload());

    expect(executionLogRepo.startExecution).toHaveBeenCalledWith(
      expect.objectContaining({ workflowId: 'wf1', workflowVersion: 2 }),
    );
    expect(executionLogRepo.failExecution).toHaveBeenCalledWith(
      'log1',
      expect.objectContaining({ code: 'TRIGGER_EVALUATION_ERROR' }),
    );
  });

  it('should keep going after one workflow fails', async () => {
    const { service, orchestrator } = build([
      { _id: 'wf1', name: 'A' },
      { _id: 'wf2', name: 'B' },
    ]);
    orchestrator.execute
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined);

    await service.evaluate(payload());

    // One broken workflow must not stop the others from running.
    expect(orchestrator.execute).toHaveBeenCalledTimes(2);
  });
});
