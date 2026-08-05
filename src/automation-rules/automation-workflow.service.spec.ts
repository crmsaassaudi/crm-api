import { BadRequestException } from '@nestjs/common';
import { AutomationWorkflowService } from './automation-workflow.service';
import { ConditionEvaluatorService } from './engine/condition-evaluator.service';

/**
 * `WorkflowNodeDto.config` is an unvalidated `Record<string, any>` stored as
 * Mixed and `type` is a free string, so every mistake used to surface only in a
 * worker: an unknown actionType dead-lettered the job, an unknown node type
 * silently truncated the branch, and a `configId` was never checked to belong to
 * the tenant — the save-time half of the cross-tenant credential hole.
 */
describe('AutomationWorkflowService node config validation', () => {
  const triggerNode = {
    id: 'trigger-1',
    type: 'trigger',
    position: { x: 0, y: 0 },
    config: {},
  };

  const build = (channelConfigExists = true, mayRunAsSystem = true) => {
    const authz = {
      canPerformAction: jest
        .fn()
        .mockResolvedValue({ allowed: mayRunAsSystem }),
    };
    const repo = {
      create: jest.fn().mockResolvedValue({ _id: 'wf1', name: 'W' }),
      findById: jest.fn(),
      update: jest.fn(),
    };
    const cls = {
      get: jest.fn((key: string) =>
        key === 'tenantId' ? 't1' : key === 'userId' ? 'user-1' : undefined,
      ),
    };
    const auditService = {
      logAction: jest.fn(),
      computeDiff: jest.fn(() => []),
    };
    const webhookHeaderCrypto = {
      encryptNodes: jest.fn((nodes: any[]) =>
        Promise.resolve({ nodes, changed: false }),
      ),
      decryptNodesForResponse: jest.fn((nodes: any[]) =>
        Promise.resolve(nodes),
      ),
      redactNodes: jest.fn((nodes: any[]) => nodes),
    };
    const channelConfigRepo = {
      findByIds: jest
        .fn()
        .mockResolvedValue(channelConfigExists ? [{ id: 'cfg1' }] : []),
    };

    const service = new AutomationWorkflowService(
      repo as any,
      cls as any,
      new ConditionEvaluatorService(),
      auditService as any,
      webhookHeaderCrypto as any,
      channelConfigRepo as any,
      authz as any,
    );
    return { service, repo, channelConfigRepo, authz };
  };

  const dto = (nodes: any[], object = 'Contact') =>
    ({
      name: 'W',
      triggerConfig: { event: 'record_created', object },
      nodes: [triggerNode, ...nodes],
      edges: [],
    }) as any;

  const action = (config: any) => ({
    id: 'a',
    type: 'action',
    position: { x: 1, y: 1 },
    config,
  });

  it('should reject an unknown node type instead of silently dropping the branch', async () => {
    const { service, repo } = build();

    await expect(
      service.create(
        dto([
          {
            id: 'x',
            type: 'approvalGate',
            position: { x: 1, y: 1 },
            config: {},
          },
        ]),
      ),
    ).rejects.toThrow(/unsupported type "approvalGate"/);
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('should reject the React Flow node spelling', async () => {
    // The web store maps `actionNode` -> `action` before it saves, so the
    // backend accepting both was a tolerance layer for a caller that does not
    // exist — and one more place for the two vocabularies to drift apart.
    const { service, repo } = build();

    await expect(
      service.create(
        dto([
          {
            id: 'a',
            type: 'actionNode',
            position: { x: 1, y: 1 },
            config: { actionType: 'add_tag', tags: ['x'] },
          },
        ]),
      ),
    ).rejects.toThrow(/unsupported type "actionNode"/);
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('should reject an unknown actionType at save time, not in the DLQ', async () => {
    const { service } = build();

    await expect(
      service.create(
        dto([
          {
            id: 'a',
            type: 'action',
            position: { x: 1, y: 1 },
            config: { actionType: 'exfiltrate_everything' },
          },
        ]),
      ),
    ).rejects.toThrow(/unknown actionType "exfiltrate_everything"/);
  });

  it('should reject an action node with no actionType', async () => {
    const { service } = build();

    await expect(
      service.create(
        dto([
          { id: 'a', type: 'action', position: { x: 1, y: 1 }, config: {} },
        ]),
      ),
    ).rejects.toThrow(/missing actionType/);
  });

  it('should reject a configId that does not belong to this tenant', async () => {
    const { service, channelConfigRepo } = build(false);

    await expect(
      service.create(
        dto([
          {
            id: 'a',
            type: 'action',
            position: { x: 1, y: 1 },
            config: {
              actionType: 'send_email',
              configId: 'cfg-of-other-tenant',
            },
          },
        ]),
      ),
    ).rejects.toThrow(/does not exist in this workspace/);

    // Tenant-scoped lookup — that is what makes "not mine" indistinguishable
    // from "not there".
    // Tenant-scoped, and one query for every reference rather than one per node.
    expect(channelConfigRepo.findByIds).toHaveBeenCalledWith('t1', [
      'cfg-of-other-tenant',
    ]);
  });

  it('should accept a configId owned by this tenant', async () => {
    const { service, repo } = build(true);

    await service.create(
      dto([
        {
          id: 'a',
          type: 'action',
          position: { x: 1, y: 1 },
          config: { actionType: 'send_email', configId: 'cfg1' },
        },
      ]),
    );

    expect(repo.create).toHaveBeenCalled();
  });

  it.each([
    [
      'delayUnit',
      { delayValue: 1, delayUnit: 'fortnights' },
      /unknown delayUnit/,
    ],
    ['delayValue', { delayValue: 0, delayUnit: 'days' }, /positive number/],
    [
      'delayValue type',
      { delayValue: 'ten', delayUnit: 'days' },
      /positive number/,
    ],
  ])(
    'should reject a wait node with a bad %s',
    async (_label, config, matcher) => {
      const { service } = build();

      await expect(
        service.create(
          dto([{ id: 'w', type: 'wait', position: { x: 1, y: 1 }, config }]),
        ),
      ).rejects.toThrow(matcher);
    },
  );

  it('should attributes the workflow to the acting user, not "system"', async () => {
    const { service, repo } = build();

    await service.create(
      dto([
        {
          id: 'a',
          type: 'action',
          position: { x: 1, y: 1 },
          config: { actionType: 'add_tag', tags: ['x'] },
        },
      ]),
    );

    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ createdBy: 'user-1', updatedBy: 'user-1' }),
    );
  });

  it.each(['send_whatsapp', 'send_zns'])(
    'should not know about %s at all — the executor was removed',
    async (actionType) => {
      // Registering an executor with no integration behind it kept a dead action
      // in three separate catalogs. There is one catalog now, and it does not
      // contain these.
      const { service, repo } = build();

      await expect(
        service.create(dto([action({ actionType })])),
      ).rejects.toThrow(/unknown actionType/);
      expect(repo.create).not.toHaveBeenCalled();
    },
  );

  it('should refuse a send_email node with no channel config', async () => {
    const { service, repo } = build();

    await expect(
      service.create(dto([action({ actionType: 'send_email' })])),
    ).rejects.toThrow(/must select a channel config/);
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('should refuse a condition node with no rules', async () => {
    const { service, repo } = build();

    await expect(
      service.create(
        dto([
          {
            id: 'c',
            type: 'condition',
            position: { x: 1, y: 1 },
            config: { logic: 'AND', rules: [] },
          },
          action({ actionType: 'add_tag', tags: ['x'] }),
        ]),
      ),
    ).rejects.toThrow(/no rules/);
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('should refuse an edge whose handle the source node does not have', async () => {
    const { service, repo } = build();

    const payload = dto([action({ actionType: 'add_tag', tags: ['x'] })]);
    payload.edges = [
      // `matched` belongs to a condition, not an action.
      { id: 'e1', source: 'a', target: 'trigger-1', sourceHandle: 'matched' },
    ];

    await expect(service.create(payload)).rejects.toThrow(/does not have/);
    expect(repo.create).not.toHaveBeenCalled();
  });

  describe('Conversation / Message triggers', () => {
    it('should accept a Conversation trigger with route_to_group', async () => {
      const { service, repo } = build();

      await service.create(
        dto(
          [action({ actionType: 'route_to_group', groupId: 'g1' })],
          'Conversation',
        ),
      );

      expect(repo.create).toHaveBeenCalled();
    });

    it.each(['update_field', 'add_tag', 'remove_tag', 'add_note'])(
      'should refuse %s on a Conversation trigger (not writable via the CRM path)',
      async (actionType) => {
        const { service } = build();

        await expect(
          service.create(
            dto(
              [action({ actionType, targetField: 'x', tags: ['t'] })],
              'Conversation',
            ),
          ),
        ).rejects.toThrow(/not writable through the CRM update path/);
      },
    );

    it('should refuse a wait node on a Message trigger (resume cannot re-read it)', async () => {
      const { service } = build();

      await expect(
        service.create(
          dto(
            [
              action({ actionType: 'send_livechat', message: 'hi' }),
              {
                id: 'w',
                type: 'wait',
                position: { x: 2, y: 2 },
                config: { delayValue: 1, delayUnit: 'hours' },
              },
            ],
            'Message',
          ),
        ),
      ).rejects.toThrow(/cannot re-read a Message when it resumes/);
    });

    it('should still allow a wait node on a Contact trigger', async () => {
      const { service, repo } = build();

      await service.create(
        dto([
          action({ actionType: 'add_tag', tags: ['x'] }),
          {
            id: 'w',
            type: 'wait',
            position: { x: 2, y: 2 },
            config: { delayValue: 1, delayUnit: 'hours' },
          },
        ]),
      );

      expect(repo.create).toHaveBeenCalled();
    });
  });

  it('should throw BadRequestException (400), not a 500, for every config problem', async () => {
    const { service } = build();

    await expect(
      service.create(
        dto([{ id: 'x', type: 'nope', position: { x: 1, y: 1 }, config: {} }]),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
