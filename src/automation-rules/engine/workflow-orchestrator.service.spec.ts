import { WorkflowOrchestratorService } from './workflow-orchestrator.service';

describe('WorkflowOrchestratorService step log batching', () => {
  let workflowRepo: any;
  let executionLogRepo: any;
  let loopPrevention: any;
  let actionProducer: any;
  let delayedProducer: any;
  let service: WorkflowOrchestratorService;

  beforeEach(() => {
    workflowRepo = {
      incrementExecutionCount: jest.fn().mockResolvedValue(undefined),
    };
    executionLogRepo = {
      startExecution: jest.fn().mockResolvedValue({ _id: 'exec_1' }),
      logStep: jest.fn().mockResolvedValue(undefined),
      logSteps: jest.fn().mockResolvedValue(undefined),
      completeExecution: jest.fn().mockResolvedValue(undefined),
      failExecution: jest.fn().mockResolvedValue(undefined),
      blockExecution: jest.fn().mockResolvedValue(undefined),
      skipExecution: jest.fn().mockResolvedValue(undefined),
    };
    loopPrevention = {
      checkDepthLimit: jest.fn().mockReturnValue({ allowed: true }),
      checkBreadcrumbs: jest.fn().mockReturnValue({ allowed: true }),
      checkStrictLoop: jest.fn().mockResolvedValue({ allowed: true }),
    };
    actionProducer = {
      dispatch: jest.fn().mockResolvedValue(undefined),
    };
    delayedProducer = {
      scheduleResume: jest.fn().mockResolvedValue(undefined),
    };

    service = new WorkflowOrchestratorService(
      workflowRepo,
      executionLogRepo,
      { evaluate: jest.fn().mockReturnValue(true) } as any,
      loopPrevention,
      actionProducer,
      delayedProducer,
      { encryptWebhookConfig: jest.fn() } as any,
    );
  });

  it('should batch DAG step logs once on successful execution', async () => {
    await service.execute(createWorkflow(actionNode()), createPayload());

    expect(executionLogRepo.logStep).not.toHaveBeenCalled();
    expect(executionLogRepo.logSteps).toHaveBeenCalledTimes(1);
    expect(executionLogRepo.logSteps).toHaveBeenCalledWith(
      'exec_1',
      expect.arrayContaining([
        expect.objectContaining({ nodeType: 'trigger' }),
        expect.objectContaining({ nodeType: 'condition' }),
        expect.objectContaining({ nodeType: 'action' }),
      ]),
    );
    expect(executionLogRepo.completeExecution).toHaveBeenCalledWith('exec_1');
  });

  it('should flush buffered logs before scheduling a wait resume', async () => {
    await service.execute(createWaitWorkflow(), createPayload());

    expect(executionLogRepo.logSteps).toHaveBeenCalledTimes(1);
    expect(delayedProducer.scheduleResume).toHaveBeenCalledTimes(1);
    expect(executionLogRepo.logSteps.mock.invocationCallOrder[0]).toBeLessThan(
      delayedProducer.scheduleResume.mock.invocationCallOrder[0],
    );
    expect(executionLogRepo.completeExecution).not.toHaveBeenCalled();
  });

  it('should flush buffered logs before marking execution failed', async () => {
    actionProducer.dispatch.mockRejectedValueOnce(new Error('dispatch failed'));

    await service.execute(createWorkflow(actionNode()), createPayload());

    expect(executionLogRepo.logSteps).toHaveBeenCalledTimes(1);
    expect(executionLogRepo.failExecution).toHaveBeenCalledWith(
      'exec_1',
      expect.objectContaining({ code: 'EXECUTION_ERROR' }),
    );
    expect(executionLogRepo.logSteps.mock.invocationCallOrder[0]).toBeLessThan(
      executionLogRepo.failExecution.mock.invocationCallOrder[0],
    );
  });

  function createWorkflow(lastNode: any) {
    const nodes = [
      { id: 'trigger_1', type: 'trigger', config: {} },
      { id: 'condition_1', type: 'condition', config: { rules: [] } },
      lastNode,
    ];
    return {
      _id: 'workflow_1',
      name: 'Test workflow',
      publishedNodes: nodes,
      publishedEdges: [
        { source: 'trigger_1', target: 'condition_1' },
        {
          source: 'condition_1',
          target: lastNode.id,
          sourceHandle: 'matched',
        },
      ],
    };
  }

  function createWaitWorkflow() {
    return {
      _id: 'workflow_1',
      name: 'Wait workflow',
      publishedNodes: [
        { id: 'trigger_1', type: 'trigger', config: {} },
        { id: 'condition_1', type: 'condition', config: { rules: [] } },
        waitNode(),
        actionNode(),
      ],
      publishedEdges: [
        { source: 'trigger_1', target: 'condition_1' },
        {
          source: 'condition_1',
          target: 'wait_1',
          sourceHandle: 'matched',
        },
        { source: 'wait_1', target: 'action_1' },
      ],
    };
  }

  function actionNode() {
    return {
      id: 'action_1',
      type: 'action',
      config: { name: 'Action', actionType: 'update_field' },
    };
  }

  function waitNode() {
    return {
      id: 'wait_1',
      type: 'wait',
      config: {
        name: 'Wait',
        delayType: 'fixed',
        delayValue: 1,
        delayUnit: 'minutes',
      },
    };
  }

  function createPayload(): any {
    return {
      tenantId: 'tenant_1',
      event: 'record_created',
      object: 'Contact',
      recordId: 'record_1',
      data: {},
    };
  }
});
