import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { AutomationExecutionLogController } from './automation-execution-log.controller';

/**
 * Retrying a step re-executes an automation action with the engine's full
 * tenant-wide reach. Before hardening it: ran on `automation_logs:retry` alone,
 * rebuilt the action from the *log* (so an edited/unpublished/deleted workflow
 * stayed executable for the log's 30-day retention), dropped the loop
 * breadcrumbs, and had no cooldown.
 */
describe('AutomationExecutionLogController.retryStep', () => {
  const actionNode = {
    id: 'n1',
    type: 'action',
    config: {
      actionType: 'webhook',
      name: 'Notify',
      webhookUrl: 'https://a.b',
    },
  };

  const build = (
    overrides: {
      workflow?: any;
      allowed?: boolean;
      lockAcquired?: boolean;
      stepStatus?: string;
      /** Value of the DLQ poison counter for this node. */
      poisonFailures?: string | null;
    } = {},
  ) => {
    const {
      workflow = {
        _id: 'wf1',
        status: 'active',
        publishedNodes: [actionNode],
      },
      allowed = true,
      poisonFailures = null,
      lockAcquired = true,
      stepStatus = 'failed',
    } = overrides;

    const executionLog = {
      _id: 'exec1',
      workflowId: 'wf1',
      workflowName: 'W',
      recordId: 'rec1',
      recordType: 'Contact',
      automationDepth: 2,
      steps: [{ nodeId: 'n1', nodeName: 'Old name', status: stepStatus }],
    };

    const repo = {
      findByIdWithSteps: jest.fn().mockResolvedValue(executionLog),
      getStepData: jest.fn().mockResolvedValue({
        step: {
          nodeName: 'Old name',
          // Stale config recorded at execution time — must NOT be what runs.
          input: {
            actionType: 'webhook',
            config: { webhookUrl: 'https://stale' },
          },
        },
        executionLog,
      }),
      retryStep: jest.fn().mockResolvedValue(stepStatus !== 'success'),
    };
    const cls = {
      get: jest.fn((key: string) =>
        key === 'tenantId' ? 't1' : key === 'userId' ? 'user-9' : undefined,
      ),
    };
    const actionProducer = { dispatch: jest.fn() };
    const crmRecordUpdate = { fetchRecord: jest.fn().mockResolvedValue(null) };
    const workflowRepo = { findById: jest.fn().mockResolvedValue(workflow) };
    const auditService = { logAction: jest.fn() };
    const authz = {
      canPerformAction: jest.fn().mockResolvedValue({ allowed }),
    };
    const redis = {
      set: jest.fn().mockResolvedValue(lockAcquired ? 'OK' : null),
      // Poison-node counter read by assertNodeNotQuarantined.
      get: jest.fn().mockResolvedValue(poisonFailures),
    };

    const idempotency = { release: jest.fn() };

    const controller = new AutomationExecutionLogController(
      repo as any,
      cls as any,
      actionProducer as any,
      crmRecordUpdate as any,
      workflowRepo as any,
      auditService as any,
      authz as any,
      idempotency as any,
      redis as any,
    );

    return {
      controller,
      repo,
      actionProducer,
      idempotency,
      workflowRepo,
      auditService,
      authz,
      redis,
    };
  };

  it('should require settings:manage_system on top of the route permission', async () => {
    const { controller, authz, actionProducer } = build({ allowed: false });

    await expect(
      controller.retryStep('exec1', { nodeId: 'n1' } as any),
    ).rejects.toThrow(ForbiddenException);

    expect(authz.canPerformAction).toHaveBeenCalledWith(
      expect.objectContaining({
        rule: { action: 'manage_system', resource: 'settings' },
        rawUserId: 'user-9',
      }),
    );
    expect(actionProducer.dispatch).not.toHaveBeenCalled();
  });

  it('should run the CURRENT published node config, not the config stored in the log', async () => {
    const { controller, actionProducer } = build();

    await controller.retryStep('exec1', { nodeId: 'n1' } as any);

    const dispatched = actionProducer.dispatch.mock.calls[0][0];
    expect(dispatched.actionConfig).toEqual(actionNode.config);
    expect(dispatched.actionConfig.webhookUrl).not.toBe('https://stale');
    expect(dispatched.nodeName).toBe('Notify');
  });

  it('should carry the loop breadcrumb so a retry cannot restart the chain', async () => {
    const { controller, actionProducer } = build();

    await controller.retryStep('exec1', { nodeId: 'n1' } as any);

    const dispatched = actionProducer.dispatch.mock.calls[0][0];
    expect(dispatched.automationBreadcrumbs).toEqual(['wf1']);
    expect(dispatched.automationDepth).toBe(2);
    expect(dispatched.sourceWorkflowId).toBe('wf1');
  });

  it('should refuse when the workflow has been deleted', async () => {
    const { controller, actionProducer } = build({ workflow: null });

    await expect(
      controller.retryStep('exec1', { nodeId: 'n1' } as any),
    ).rejects.toThrow(NotFoundException);
    expect(actionProducer.dispatch).not.toHaveBeenCalled();
  });

  it.each(['paused', 'draft'])(
    'should refuse when the workflow is %s',
    async (status) => {
      const { controller, actionProducer } = build({
        workflow: { _id: 'wf1', status, publishedNodes: [actionNode] },
      });

      await expect(
        controller.retryStep('exec1', { nodeId: 'n1' } as any),
      ).rejects.toThrow(BadRequestException);
      expect(actionProducer.dispatch).not.toHaveBeenCalled();
    },
  );

  it('should refuse when the node is no longer in the published snapshot', async () => {
    const { controller, actionProducer } = build({
      workflow: { _id: 'wf1', status: 'active', publishedNodes: [] },
    });

    await expect(
      controller.retryStep('exec1', { nodeId: 'n1' } as any),
    ).rejects.toThrow(/not part of the workflow's current published version/);
    expect(actionProducer.dispatch).not.toHaveBeenCalled();
  });

  it('should refuse a non-action node', async () => {
    const { controller } = build({
      workflow: {
        _id: 'wf1',
        status: 'active',
        publishedNodes: [{ id: 'n1', type: 'condition', config: {} }],
      },
    });

    await expect(
      controller.retryStep('exec1', { nodeId: 'n1' } as any),
    ).rejects.toThrow(/only action nodes can be retried/);
  });

  it('should rate-limit repeat retries of the same step', async () => {
    const { controller, actionProducer, redis } = build({
      lockAcquired: false,
    });

    await expect(
      controller.retryStep('exec1', { nodeId: 'n1' } as any),
    ).rejects.toThrow(/retried in the last/);

    expect(redis.set).toHaveBeenCalledWith(
      'automation:retry:t1:exec1:n1',
      '1',
      'EX',
      60,
      'NX',
    );
    expect(actionProducer.dispatch).not.toHaveBeenCalled();
  });

  it('should refuse a node the DLQ processor has quarantined', async () => {
    const { controller, actionProducer, redis } = build({
      poisonFailures: '25',
    });

    await expect(
      controller.retryStep('exec1', { nodeId: 'n1' } as any),
    ).rejects.toThrow(/quarantined/);

    expect(redis.get).toHaveBeenCalledWith('automation:poison:t1:wf1:n1');
    expect(actionProducer.dispatch).not.toHaveBeenCalled();
  });

  it('should allow a retry while the node is below the poison threshold', async () => {
    const { controller, actionProducer } = build({ poisonFailures: '24' });

    await controller.retryStep('exec1', { nodeId: 'n1' } as any);

    expect(actionProducer.dispatch).toHaveBeenCalled();
  });

  it('should clear the exactly-once claim so the retry is not skipped as a duplicate', async () => {
    const { controller, idempotency } = build();

    await controller.retryStep('exec1', { nodeId: 'n1' } as any);

    // A DLQ'd step still holds a confirmed claim; without releasing it the
    // redispatched job would be dropped and the retry would do nothing.
    expect(idempotency.release).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 't1',
        executionId: 'exec1',
        nodeId: 'n1',
      }),
    );
  });

  it('should record who performed the retry', async () => {
    const { controller, auditService } = build();

    await controller.retryStep('exec1', { nodeId: 'n1' } as any);

    expect(auditService.logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 't1',
        userId: 'user-9',
        workflowId: 'wf1',
        action: 'step_retried',
        metadata: expect.objectContaining({
          executionId: 'exec1',
          nodeId: 'n1',
          actionType: 'webhook',
        }),
      }),
    );
  });
});
