import {
  AutomationAssigneeResolver,
  CreateRecordExecutor,
  CreateTicketExecutor,
  SendEmailExecutor,
} from './action-executors';
import { TemplateInterpolationService } from './template-interpolation.service';
import { AutomationActionJobData } from '../queue/automation-queue.constants';

const job = (
  overrides: Partial<AutomationActionJobData> = {},
): AutomationActionJobData =>
  ({
    executionId: 'exec1',
    workflowId: 'wf1',
    tenantId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
    nodeId: 'n1',
    nodeName: 'node',
    actionType: 'send_email',
    actionConfig: {},
    recordId: 'rec1',
    recordType: 'Contact',
    recordData: { emails: ['a@b.com'] },
    automationDepth: 0,
    sourceWorkflowId: 'wf1',
    ...overrides,
  }) as AutomationActionJobData;

describe('SendEmailExecutor channel-config tenancy', () => {
  it('should resolve credentials through the tenant guard, never the raw pool', async () => {
    const transportPool = {
      resolveWithTenantGuard: jest.fn().mockResolvedValue(null),
      // Present so a regression that calls it would resolve rather than crash,
      // making the assertion below the thing that fails.
      resolve: jest.fn().mockResolvedValue({
        tenantId: 'other-tenant',
        name: 'victim smtp',
        status: 'active',
        publicSettings: { fromEmail: 'billing@victim.example' },
      }),
    };
    const emailProvider = { send: jest.fn() };

    const executor = new SendEmailExecutor(
      new TemplateInterpolationService(),
      emailProvider as any,
      undefined,
      undefined,
      transportPool as any,
    );

    const result = await executor.execute(
      job({ actionConfig: { configId: 'cfg-of-another-tenant' } }),
    );

    expect(transportPool.resolveWithTenantGuard).toHaveBeenCalledWith(
      'cfg-of-another-tenant',
      'aaaaaaaaaaaaaaaaaaaaaaaa',
    );
    expect(transportPool.resolve).not.toHaveBeenCalled();
    // Guard returned null (tenant mismatch) → nothing is sent.
    expect(emailProvider.send).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('CHANNEL_CONFIG_NOT_FOUND');
  });
});

describe('CreateRecordExecutor field protection', () => {
  const build = () => {
    const contactsService = {
      create: jest.fn().mockResolvedValue({ id: 'c1' }),
    };
    const executor = new CreateRecordExecutor(
      new TemplateInterpolationService(),
      contactsService as any,
    );
    return { executor, contactsService };
  };

  it.each([
    ['ownerId', { ownerId: '507f1f77bcf86cd799439011' }],
    ['tenantId', { tenantId: 'bbbbbbbbbbbbbbbbbbbbbbbb' }],
    ['orgUnitId', { orgUnitId: '507f1f77bcf86cd799439012' }],
    ['_id', { _id: '507f1f77bcf86cd799439013' }],
    ['createdById', { createdById: '507f1f77bcf86cd799439014' }],
  ])('should refuse a field map that sets %s', async (_label, fields) => {
    const { executor, contactsService } = build();

    const result = await executor.execute(
      job({
        actionType: 'create_record',
        actionConfig: {
          recordType: 'Contact',
          fieldMappings: { firstName: 'Ada', ...fields },
        },
      }),
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('PROTECTED_FIELD');
    // Non-retryable: repeating a denied write just repeats the denial.
    expect(result.retryable).toBe(false);
    expect(contactsService.create).not.toHaveBeenCalled();
  });

  it('should still create records from an ordinary field map', async () => {
    const { executor, contactsService } = build();

    const result = await executor.execute(
      job({
        actionType: 'create_record',
        actionConfig: {
          recordType: 'Contact',
          fieldMappings: { firstName: 'Ada', emails: ['ada@example.com'] },
        },
      }),
    );

    expect(result.success).toBe(true);
    expect(contactsService.create).toHaveBeenCalledWith({
      firstName: 'Ada',
      emails: ['ada@example.com'],
    });
  });
});

describe('AutomationAssigneeResolver', () => {
  const attributes = { ownerId: 'trigger-owner' };

  it('should ask the core to validate a pinned assignee instead of trusting it', async () => {
    const assignmentCore = {
      assign: jest.fn().mockResolvedValue({
        outcome: 'assigned',
        assigneeId: 'agent-1',
        groupId: 'group-1',
        reason: 'ok',
      }),
    };
    const resolver = new AutomationAssigneeResolver(assignmentCore as any);

    const result = await resolver.resolve({
      tenantId: 't1',
      objectType: 'Ticket',
      assigneeId: 'agent-1',
      groupId: 'group-1',
      attributes,
    });

    expect(result).toEqual({
      ok: true,
      ownerId: 'agent-1',
      groupId: 'group-1',
    });
    const request = assignmentCore.assign.mock.calls[0][0];
    // targetUserId goes through eligibility; manualAssigneeId would skip it.
    expect(request.targetUserId).toBe('agent-1');
    expect(request.manualAssigneeId).toBeUndefined();
    expect(request.dryRun).toBe(true);
  });

  it('should refuse an ineligible assignee rather than writing ownerId anyway', async () => {
    const assignmentCore = {
      assign: jest.fn().mockResolvedValue({
        outcome: 'failed',
        assigneeId: null,
        groupId: null,
        reason: 'Agent is not in the channel support pool',
      }),
    };
    const resolver = new AutomationAssigneeResolver(assignmentCore as any);

    const result = await resolver.resolve({
      tenantId: 't1',
      objectType: 'Ticket',
      assigneeId: 'outsider',
      attributes,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('NO_ELIGIBLE_AGENT');
      expect(result.error.message).toMatch(/channel support pool/);
    }
  });

  it('should inherit the trigger record owner when no target is configured', async () => {
    const assignmentCore = { assign: jest.fn() };
    const resolver = new AutomationAssigneeResolver(assignmentCore as any);

    const result = await resolver.resolve({
      tenantId: 't1',
      objectType: 'Task',
      attributes,
      fallbackOwnerId: 'trigger-owner',
    });

    expect(result).toEqual({
      ok: true,
      ownerId: 'trigger-owner',
      groupId: null,
    });
    // No target named → nothing for the engine to decide.
    expect(assignmentCore.assign).not.toHaveBeenCalled();
  });
});

describe('CreateTicketExecutor assignment', () => {
  it('should write the ownerId the engine approved, not the configured one', async () => {
    const ticketsService = {
      create: jest
        .fn()
        .mockResolvedValue({ id: 'tk1', ticketNumber: 'T-1', subject: 'S' }),
    };
    const assignmentCore = {
      assign: jest.fn().mockResolvedValue({
        outcome: 'assigned',
        // The engine re-selected someone else within the requested group.
        assigneeId: 'eligible-agent',
        groupId: 'group-1',
        reason: 'round robin',
      }),
    };
    const executor = new CreateTicketExecutor(
      ticketsService as any,
      new TemplateInterpolationService(),
      new AutomationAssigneeResolver(assignmentCore as any),
    );

    const result = await executor.execute(
      job({
        actionType: 'create_ticket',
        actionConfig: {
          subject: 'Help',
          assigneeId: 'requested-agent',
          groupId: 'group-1',
        },
      }),
    );

    expect(result.success).toBe(true);
    expect(ticketsService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: 'eligible-agent',
        groupId: 'group-1',
      }),
    );
  });

  it('should does not create the ticket when the target is rejected', async () => {
    const ticketsService = { create: jest.fn() };
    const assignmentCore = {
      assign: jest.fn().mockResolvedValue({
        outcome: 'failed',
        assigneeId: null,
        groupId: null,
        reason: 'No eligible agent',
      }),
    };
    const executor = new CreateTicketExecutor(
      ticketsService as any,
      new TemplateInterpolationService(),
      new AutomationAssigneeResolver(assignmentCore as any),
    );

    const result = await executor.execute(
      job({
        actionType: 'create_ticket',
        actionConfig: { subject: 'Help', assigneeId: 'outsider' },
      }),
    );

    expect(result.success).toBe(false);
    expect(ticketsService.create).not.toHaveBeenCalled();
  });
});
