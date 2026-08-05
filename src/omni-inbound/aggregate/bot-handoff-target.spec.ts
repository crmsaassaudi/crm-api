import { Types } from 'mongoose';
import { ForbiddenException } from '@nestjs/common';
import { ConversationOpsProcessor } from './conversation-ops.processor';

/**
 * A bot handoff names the agent or group to assign. Those ids are flow content
 * — chosen in the bot Builder, delivered over the callback as plain strings —
 * and the assignment primitive downstream writes whatever it is handed.
 *
 * Before this, nothing re-checked them, so a hand-edited flow could assign a
 * conversation to another tenant's agent, or to an agent an admin had
 * deliberately excluded from the channel's support pool. These tests pin the
 * verification and the safe degradation: refuse the target, keep the handoff.
 */
describe('ConversationOpsProcessor — bot handoff target validation', () => {
  const AGENT = new Types.ObjectId().toString();
  const GROUP = new Types.ObjectId().toString();
  const conversation = { id: 'conv_1', channelId: 'chan_1' };

  const build = (opts: {
    tenantUsers?: string[];
    tenantGroups?: string[];
    agentEligible?: boolean;
    groupEligible?: boolean;
  }) => {
    const processor = Object.create(
      ConversationOpsProcessor.prototype,
    ) as ConversationOpsProcessor;

    Object.assign(processor, {
      logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
      userRepository: {
        findByIds: jest
          .fn()
          .mockImplementation((ids: string[]) =>
            Promise.resolve(
              ids
                .filter((id) => (opts.tenantUsers ?? []).includes(id))
                .map((id) => ({ id })),
            ),
          ),
      },
      groupRepository: {
        findById: jest
          .fn()
          .mockImplementation((_tenantId: string, id: string) =>
            Promise.resolve(
              (opts.tenantGroups ?? []).includes(id) ? { id } : null,
            ),
          ),
      },
      channelSupport: {
        assertAgentEligible: jest.fn().mockImplementation(() =>
          opts.agentEligible === false
            ? Promise.reject(
                new ForbiddenException({
                  code: 'OMNI_AGENT_NOT_IN_CHANNEL_POOL',
                }),
              )
            : Promise.resolve(),
        ),
        assertGroupEligible: jest.fn().mockImplementation(() =>
          opts.groupEligible === false
            ? Promise.reject(
                new ForbiddenException({
                  code: 'OMNI_GROUP_NOT_IN_CHANNEL_POOL',
                }),
              )
            : Promise.resolve(),
        ),
      },
    });

    return processor;
  };

  const resolve = (processor: ConversationOpsProcessor, meta: any) =>
    (processor as any).resolveHandoffTarget('t1', conversation, meta);

  it('should keep a target that is both in the tenant and in the channel pool', async () => {
    const processor = build({ tenantUsers: [AGENT] });

    await expect(
      resolve(processor, { target: 'agent', agentId: AGENT }),
    ).resolves.toEqual({ target: 'agent', targetId: AGENT });
  });

  it('should refuse an agent that is not a member of the tenant', async () => {
    // The cross-tenant case: a valid ObjectId belonging to someone else. The
    // tenant-scoped read returns nothing, and that IS the rejection.
    const processor = build({ tenantUsers: [] });

    await expect(
      resolve(processor, { target: 'agent', agentId: AGENT }),
    ).resolves.toEqual({ target: 'general' });
  });

  it('should refuse an agent outside a restricted channel support pool', async () => {
    const processor = build({ tenantUsers: [AGENT], agentEligible: false });

    await expect(
      resolve(processor, { target: 'agent', agentId: AGENT }),
    ).resolves.toEqual({ target: 'general' });
  });

  it('should refuse a group from another tenant', async () => {
    const processor = build({ tenantGroups: [] });

    await expect(
      resolve(processor, { target: 'group', groupId: GROUP }),
    ).resolves.toEqual({ target: 'general' });
  });

  it('should refuse a group outside a restricted channel support pool', async () => {
    const processor = build({ tenantGroups: [GROUP], groupEligible: false });

    await expect(
      resolve(processor, { target: 'group', groupId: GROUP }),
    ).resolves.toEqual({ target: 'general' });
  });

  it('should refuse a malformed id without letting it reach the database', async () => {
    const processor = build({ tenantUsers: [AGENT] });

    await expect(
      resolve(processor, { target: 'agent', agentId: 'not-an-object-id' }),
    ).resolves.toEqual({ target: 'general' });
    expect((processor as any).userRepository.findByIds).not.toHaveBeenCalled();
  });

  it('should treat a missing or unknown target as a general handoff', async () => {
    const processor = build({});

    await expect(resolve(processor, undefined)).resolves.toEqual({
      target: 'general',
    });
    await expect(resolve(processor, { target: 'general' })).resolves.toEqual({
      target: 'general',
    });
    await expect(resolve(processor, { target: 'agent' })).resolves.toEqual({
      target: 'general',
    });
  });
});
