import {
  AutomationAssigneeResolver,
  CreateRecordExecutor,
  CreateTicketExecutor,
  SendEmailExecutor,
  SendSmsExecutor,
  AddNoteExecutor,
  InternalNotificationExecutor,
  SendLivechatExecutor,
} from './index';
import { TemplateVariableRegistryService } from '../../../templates/services/template-variable-registry.service';
import { AutomationActionJobData } from '../../queue/automation-queue.constants';

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
    recordData: { emails: ['a@b.com'], phones: ['+849000000'] },
    automationDepth: 0,
    sourceWorkflowId: 'wf1',
    executionSessionId: 'sess1',
    workflowVersion: 1,
    publishedNodes: [{ id: 'n1', type: 'action', config: {} }],
    publishedEdges: [],
    principal: { kind: 'system', runAs: 'system' },
    ...overrides,
  }) as AutomationActionJobData;

const templates = () => new TemplateVariableRegistryService();

describe('SendEmailExecutor channel-config tenancy', () => {
  it('should resolve credentials through the tenant guard, never the raw pool', async () => {
    const transportPool = {
      resolveWithTenantGuard: jest.fn().mockResolvedValue(null),
      // Present so a regression that calls it would resolve rather than crash,
      // making the assertion below the thing that fails.
      resolve: jest.fn().mockResolvedValue({
        tenantId: 'other-tenant',
        providerType: 'smtp',
        name: 'victim smtp',
        status: 'active',
        publicSettings: { fromEmail: 'billing@victim.example' },
      }),
    };

    const executor = new SendEmailExecutor(
      templates(),
      transportPool as any,
      {} as any,
      { emit: jest.fn() } as any,
    );

    const result = await executor.execute(
      job({ actionConfig: { configId: 'cfg-of-another-tenant' } }),
    );

    expect(transportPool.resolveWithTenantGuard).toHaveBeenCalledWith(
      'cfg-of-another-tenant',
      'aaaaaaaaaaaaaaaaaaaaaaaa',
    );
    expect(transportPool.resolve).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('CHANNEL_CONFIG_NOT_FOUND');
    expect(result.retryable).toBe(false);
  });

  it('should refuse to send when the node names no channel config', async () => {
    const transportPool = { resolveWithTenantGuard: jest.fn() };
    const executor = new SendEmailExecutor(
      templates(),
      transportPool as any,
      {} as any,
      { emit: jest.fn() } as any,
    );

    const result = await executor.execute(job({ actionConfig: {} }));

    // No platform-wide sender exists to fall back to, and pretending otherwise
    // is how tenant mail went out over the platform's relay.
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('NO_CHANNEL_CONFIG');
    expect(transportPool.resolveWithTenantGuard).not.toHaveBeenCalled();
  });

  it('should refuse a config whose provider type cannot send email', async () => {
    const transportPool = {
      resolveWithTenantGuard: jest.fn().mockResolvedValue({
        tenantId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
        providerType: 'facebook',
        name: 'fb page',
        status: 'active',
        credentials: {},
        publicSettings: {},
      }),
    };
    const executor = new SendEmailExecutor(
      templates(),
      transportPool as any,
      {} as any,
      { emit: jest.fn() } as any,
    );

    const result = await executor.execute(
      job({ actionConfig: { configId: 'cfg1' } }),
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('UNSUPPORTED_PROVIDER');
  });
});

describe('SendSmsExecutor', () => {
  const transportWith = (credentials: any, publicSettings: any) => ({
    resolveWithTenantGuard: jest.fn().mockResolvedValue({
      tenantId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      providerType: 'twilio',
      name: 'tenant twilio',
      status: 'active',
      credentials,
      publicSettings,
    }),
  });

  it('should refuse an incomplete config instead of sending from a shared number', async () => {
    const executor = new SendSmsExecutor(
      templates(),
      transportWith({}, {}) as any,
      {} as any,
      { emit: jest.fn() } as any,
    );

    const result = await executor.execute(
      job({
        actionType: 'send_sms',
        actionConfig: { configId: 'cfg1', message: 'hi' },
      }),
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('CHANNEL_CONFIG_INCOMPLETE');
    expect(result.retryable).toBe(false);
  });
});

describe('actions that used to report success without delivering', () => {
  it('should fail add_note when no contact can be resolved', async () => {
    const notesService = { createForContact: jest.fn() };
    const executor = new AddNoteExecutor(notesService as any, templates());

    const result = await executor.execute(
      job({
        actionType: 'add_note',
        recordType: 'Deal',
        recordData: {},
        actionConfig: { content: 'Deal won' },
      }),
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('NO_CONTACT');
    expect(notesService.createForContact).not.toHaveBeenCalled();
  });

  it('should publish internal_notification on the realtime bridge', async () => {
    const redis = { publish: jest.fn().mockResolvedValue(1) };
    const executor = new InternalNotificationExecutor(
      templates(),
      redis as any,
    );

    const result = await executor.execute(
      job({
        actionType: 'internal_notification',
        recordData: { ownerId: 'user-1' },
        actionConfig: { recipientType: 'owner', title: 'Hi', message: 'There' },
      }),
    );

    expect(result.success).toBe(true);
    expect(redis.publish).toHaveBeenCalledWith(
      'socket:automation:notification',
      expect.stringContaining('user-1'),
    );
  });

  it('should refuse an internal_notification audience nothing can resolve', async () => {
    const redis = { publish: jest.fn() };
    const executor = new InternalNotificationExecutor(
      templates(),
      redis as any,
    );

    const result = await executor.execute(
      job({
        actionType: 'internal_notification',
        actionConfig: { recipientType: 'all_admins' },
      }),
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('UNSUPPORTED_RECIPIENT_TYPE');
    expect(redis.publish).not.toHaveBeenCalled();
  });

  it('should deliver send_livechat through the outbound service', async () => {
    const outbound = {
      sendBotMessage: jest
        .fn()
        .mockResolvedValue({ ok: true, messageId: 'm1' }),
    };
    const moduleRef = { get: jest.fn().mockReturnValue(outbound) };
    const executor = new SendLivechatExecutor(templates(), moduleRef as any);

    const result = await executor.execute(
      job({
        actionType: 'send_livechat',
        recordType: 'Conversation',
        recordId: 'conv1',
        actionConfig: { message: 'Hello' },
      }),
    );

    expect(result.success).toBe(true);
    expect(outbound.sendBotMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv1',
        content: 'Hello',
        // (execution, node) so a redelivered job cannot post twice.
        idempotencyKey: 'automation:exec1:n1',
      }),
    );
  });
});

describe('CreateRecordExecutor field protection', () => {
  const build = () => {
    const contactsService = {
      create: jest.fn().mockResolvedValue({ id: 'c1' }),
    };
    const executor = new CreateRecordExecutor(
      templates(),
      contactsService as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    return { executor, contactsService };
  };

  it.each([
    ['ownerId', { ownerId: '507f1f77bcf86cd799439011' }],
    ['tenantId', { tenantId: 'bbbbbbbbbbbbbbbbbbbbbbbb' }],
    ['orgUnitId', { orgUnitId: '507f1f77bcf86cd799439012' }],
    ['_id', { _id: '507f1f77bcf86cd799439013' }],
    ['createdById', { createdById: '507f1f77bcf86cd799439014' }],
  ])('refuses a field map that sets %s', async (_label, fields) => {
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
      templates(),
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

  it('should not create the ticket when the target is rejected', async () => {
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
      templates(),
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
