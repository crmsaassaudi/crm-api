import { WorkflowOrchestratorService } from './workflow-orchestrator.service';
import { AutomationActionJobData } from '../queue/automation-queue.constants';

describe('WorkflowOrchestratorService', () => {
  let workflowRepo: any;
  let executionLogRepo: any;
  let loopPrevention: any;
  let actionProducer: any;
  let delayedProducer: any;
  let conditionEvaluator: any;
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
      checkAndMarkRunOnce: jest.fn().mockResolvedValue({ allowed: true }),
    };
    actionProducer = { dispatch: jest.fn().mockResolvedValue(undefined) };
    delayedProducer = {
      scheduleResume: jest.fn().mockResolvedValue(undefined),
    };
    conditionEvaluator = { evaluate: jest.fn().mockReturnValue(true) };

    service = new WorkflowOrchestratorService(
      workflowRepo,
      executionLogRepo,
      conditionEvaluator,
      loopPrevention,
      actionProducer,
      delayedProducer,
      { encryptWebhookConfig: jest.fn() } as any,
    );
  });

  describe('suspension at an action node', () => {
    it('should dispatch the action and NOT complete the execution yet', async () => {
      await service.execute(
        createWorkflow([actionNode('action_1')]),
        payload(),
      );

      expect(actionProducer.dispatch).toHaveBeenCalledTimes(1);
      // The action has been queued, not performed. Marking the execution
      // successful here is what made "success rate" mean "dispatch rate".
      expect(executionLogRepo.completeExecution).not.toHaveBeenCalled();
      expect(workflowRepo.incrementExecutionCount).not.toHaveBeenCalled();
    });

    it('should log the trigger and condition steps, and no placeholder for the action', async () => {
      await service.execute(
        createWorkflow([actionNode('action_1')]),
        payload(),
      );

      expect(executionLogRepo.logSteps).toHaveBeenCalledTimes(1);
      const steps = executionLogRepo.logSteps.mock.calls[0][1];
      expect(steps.map((s: any) => s.nodeType)).toEqual([
        'trigger',
        'condition',
      ]);
      // The worker owns the action's single step, with its real outcome.
      expect(steps.some((s: any) => s.nodeType === 'action')).toBe(false);
    });

    it('should pin the graph and principal into the action job so the worker can continue', async () => {
      await service.execute(
        createWorkflow([actionNode('action_1')]),
        payload(),
      );

      const dispatched = actionProducer.dispatch.mock
        .calls[0][0] as AutomationActionJobData;
      expect(dispatched.publishedNodes).toHaveLength(3);
      expect(dispatched.publishedEdges).toHaveLength(2);
      expect(dispatched.executionSessionId).toEqual(expect.any(String));
      expect(dispatched.principal).toBeDefined();
      expect(dispatched.workflowVersion).toBe(7);
    });

    it('should dispatch every action a node fans out to, not just the first', async () => {
      const workflow = createWorkflow(
        [actionNode('action_1'), actionNode('action_2')],
        [
          { source: 'trigger_1', target: 'condition_1' },
          {
            source: 'condition_1',
            target: 'action_1',
            sourceHandle: 'matched',
          },
          {
            source: 'condition_1',
            target: 'action_2',
            sourceHandle: 'matched',
          },
        ],
      );

      await service.execute(workflow, payload());

      // Returning early at the first suspension silently dropped every parallel
      // branch after it.
      expect(actionProducer.dispatch).toHaveBeenCalledTimes(2);
    });
  });

  describe('continueAfterAction', () => {
    const graph = () => ({
      publishedNodes: [
        actionNode('action_1'),
        actionNode('recovery'),
        actionNode('next'),
      ],
      publishedEdges: [
        { source: 'action_1', target: 'next', sourceHandle: 'success' },
        { source: 'action_1', target: 'recovery', sourceHandle: 'failure' },
      ],
    });

    const actionJob = (): AutomationActionJobData =>
      ({
        executionId: 'exec_1',
        workflowId: 'workflow_1',
        tenantId: 'tenant_1',
        nodeId: 'action_1',
        nodeName: 'Action',
        actionType: 'update_field',
        actionConfig: {},
        recordId: 'record_1',
        recordType: 'Contact',
        recordData: {},
        automationDepth: 0,
        sourceWorkflowId: 'workflow_1',
        executionSessionId: 'sess_1',
        workflowVersion: 7,
        principal: { kind: 'system', runAs: 'system' },
        ...graph(),
      }) as AutomationActionJobData;

    it('should follow only the success branch when the action succeeded', async () => {
      await service.continueAfterAction(actionJob(), 'success');

      expect(actionProducer.dispatch).toHaveBeenCalledTimes(1);
      expect(actionProducer.dispatch.mock.calls[0][0].nodeId).toBe('next');
    });

    it('should follow only the failure branch when the action failed', async () => {
      await service.continueAfterAction(actionJob(), 'failure', {
        code: 'SMS_SEND_FAILED',
        message: 'provider rejected',
      });

      expect(actionProducer.dispatch).toHaveBeenCalledTimes(1);
      expect(actionProducer.dispatch.mock.calls[0][0].nodeId).toBe('recovery');
    });

    it('should mark the execution failed even when a recovery branch ran', async () => {
      await service.continueAfterAction(actionJob(), 'failure', {
        code: 'SMS_SEND_FAILED',
        message: 'provider rejected',
      });

      // The escalation path executing does not mean the message was delivered.
      expect(executionLogRepo.failExecution).toHaveBeenCalledWith(
        'exec_1',
        expect.objectContaining({
          code: 'SMS_SEND_FAILED',
          nodeId: 'action_1',
        }),
      );
      expect(executionLogRepo.completeExecution).not.toHaveBeenCalled();
    });

    it('should not walk an unlabelled edge after a failure', async () => {
      const job = actionJob();
      job.publishedEdges = [{ source: 'action_1', target: 'next' }];

      await service.continueAfterAction(job, 'failure', {
        code: 'X',
        message: 'x',
      });

      // A plain "next step" arrow means "then do this", not "do this regardless".
      expect(actionProducer.dispatch).not.toHaveBeenCalled();
    });

    it('should complete the execution when the success branch ends the graph', async () => {
      const job = actionJob();
      job.publishedEdges = [];

      await service.continueAfterAction(job, 'success');

      expect(executionLogRepo.completeExecution).toHaveBeenCalledWith('exec_1');
      expect(workflowRepo.incrementExecutionCount).toHaveBeenCalledWith(
        'tenant_1',
        'workflow_1',
      );
    });
  });

  describe('wait node', () => {
    it('should flush buffered logs before scheduling the resume', async () => {
      await service.execute(
        createWorkflow(
          [waitNode(), actionNode('action_1')],
          [
            { source: 'trigger_1', target: 'condition_1' },
            {
              source: 'condition_1',
              target: 'wait_1',
              sourceHandle: 'matched',
            },
            { source: 'wait_1', target: 'action_1' },
          ],
        ),
        payload(),
      );

      expect(delayedProducer.scheduleResume).toHaveBeenCalledTimes(1);
      expect(
        executionLogRepo.logSteps.mock.invocationCallOrder[0],
      ).toBeLessThan(
        delayedProducer.scheduleResume.mock.invocationCallOrder[0],
      );
      expect(executionLogRepo.completeExecution).not.toHaveBeenCalled();
    });
  });

  describe('run-once', () => {
    it('should read the flag from the PUBLISHED trigger config', async () => {
      const workflow = createWorkflow([actionNode('action_1')]);
      workflow.publishedTriggerConfig = { runOncePerRecord: true };
      // The draft says otherwise. Honouring the draft meant a workflow could lose
      // its run-once protection without anyone publishing anything.
      workflow.triggerConfig = { runOncePerRecord: false };
      loopPrevention.checkAndMarkRunOnce.mockResolvedValue({
        allowed: false,
        reason: 'already ran',
      });

      await service.execute(workflow, payload());

      expect(loopPrevention.checkAndMarkRunOnce).toHaveBeenCalled();
      expect(executionLogRepo.skipExecution).toHaveBeenCalledWith('exec_1');
      expect(actionProducer.dispatch).not.toHaveBeenCalled();
    });
  });

  describe('dispatch failure', () => {
    it('should flush buffered logs before marking the execution failed', async () => {
      actionProducer.dispatch.mockRejectedValueOnce(
        new Error('dispatch failed'),
      );

      await service.execute(
        createWorkflow([actionNode('action_1')]),
        payload(),
      );

      // Two writes: the path taken to the action (flushed before dispatch), then
      // the dispatch failure itself.
      expect(executionLogRepo.logSteps).toHaveBeenCalledTimes(2);
      expect(executionLogRepo.logSteps.mock.calls[1][1]).toEqual([
        expect.objectContaining({
          nodeType: 'action',
          status: 'failed',
          error: expect.objectContaining({ code: 'ACTION_DISPATCH_FAILED' }),
        }),
      ]);
      expect(executionLogRepo.failExecution).toHaveBeenCalledWith(
        'exec_1',
        expect.objectContaining({ code: 'EXECUTION_ERROR' }),
      );
      expect(
        executionLogRepo.logSteps.mock.invocationCallOrder[1],
      ).toBeLessThan(
        executionLogRepo.failExecution.mock.invocationCallOrder[0],
      );
    });
  });

  function createWorkflow(tailNodes: any[], edges?: any[]) {
    const nodes = [
      { id: 'trigger_1', type: 'trigger', config: {} },
      {
        id: 'condition_1',
        type: 'condition',
        config: {
          logic: 'AND',
          rules: [{ field: 'a', operator: 'eq', value: 'b' }],
        },
      },
      ...tailNodes,
    ];
    return {
      _id: 'workflow_1',
      name: 'Test workflow',
      version: 7,
      runAs: 'system',
      createdBy: 'system',
      publishedTriggerConfig: { runOncePerRecord: false },
      publishedNodes: nodes,
      publishedEdges: edges ?? [
        { source: 'trigger_1', target: 'condition_1' },
        {
          source: 'condition_1',
          target: tailNodes[0].id,
          sourceHandle: 'matched',
        },
      ],
    } as any;
  }

  function actionNode(id: string) {
    return {
      id,
      type: 'action',
      config: { name: id, actionType: 'update_field' },
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

  function payload(): any {
    return {
      tenantId: 'tenant_1',
      event: 'record_created',
      object: 'Contact',
      recordId: 'record_1',
      data: {},
    };
  }
});
