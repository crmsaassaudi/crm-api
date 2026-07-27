import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import {
  ForbiddenException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Types } from 'mongoose';
import { ChannelSupportService } from './channel-support.service';
import { ChannelRepository } from '../infrastructure/persistence/document/repositories/channel.repository';

const TENANT = new Types.ObjectId().toString();
const AGENT_IN_POOL = new Types.ObjectId().toString();
const AGENT_IN_GROUP = new Types.ObjectId().toString();
const AGENT_OUTSIDE = new Types.ObjectId().toString();
const GROUP_A = new Types.ObjectId().toString();
const GROUP_B = new Types.ObjectId().toString();

/** Minimal Channel-shaped object; only the fields the service reads. */
function channel(
  id: string,
  support: {
    userIds?: string[];
    groupIds?: string[];
    mode?: 'restricted' | 'open';
  },
) {
  return {
    id,
    tenantId: TENANT,
    type: 'livechat',
    name: `Channel ${id}`,
    account: `acct-${id}`,
    status: 'Connected',
    config: {},
    support: {
      userIds: support.userIds ?? [],
      groupIds: support.groupIds ?? [],
      mode: support.mode ?? 'open',
    },
  } as any;
}

describe('ChannelSupportService', () => {
  let service: ChannelSupportService;
  let channelRepo: any;
  let groupModel: any;
  let userModel: any;

  /** Groups returned by the group lookup, keyed by id. */
  let groupMembers: Record<string, string[]>;

  const buildQuery = (result: any) => ({
    select: () => ({ lean: () => ({ exec: () => Promise.resolve(result) }) }),
  });

  beforeEach(async () => {
    groupMembers = { [GROUP_A]: [AGENT_IN_GROUP] };

    channelRepo = {
      findAll: jest.fn().mockResolvedValue([]),
      findById: jest.fn().mockResolvedValue(null),
      findAnyByAccount: jest.fn().mockResolvedValue(null),
      update: jest.fn((_t: string, id: string, data: any) =>
        Promise.resolve(channel(id, data.support)),
      ),
      pullSupportMembers: jest.fn().mockResolvedValue(1),
    };

    groupModel = {
      find: jest.fn((filter: any) => {
        const ids = (filter?._id?.$in ?? []).map(String);
        return buildQuery(
          ids
            .filter((id: string) => groupMembers[id])
            .map((id: string) => ({ _id: id, memberIds: groupMembers[id] })),
        );
      }),
    };

    userModel = {
      find: jest.fn((filter: any) =>
        buildQuery((filter?._id?.$in ?? []).map((id: any) => ({ _id: id }))),
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChannelSupportService,
        { provide: ChannelRepository, useValue: channelRepo },
        { provide: ClsService, useValue: { get: () => TENANT } },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        { provide: getModelToken('GroupSchemaClass'), useValue: groupModel },
        { provide: getModelToken('UserSchemaClass'), useValue: userModel },
      ],
    }).compile();

    service = module.get(ChannelSupportService);
  });

  // ──────────────────────────────────────────────────────────────────────
  // Pool resolution
  // ──────────────────────────────────────────────────────────────────────

  describe('resolvePool', () => {
    it('should union direct users with group members', async () => {
      channelRepo.findAll.mockResolvedValue([
        channel('ch1', {
          userIds: [AGENT_IN_POOL],
          groupIds: [GROUP_A],
          mode: 'restricted',
        }),
      ]);

      const pool = await service.resolvePool(TENANT, 'ch1');

      expect(pool?.agentIds?.sort()).toEqual(
        [AGENT_IN_POOL, AGENT_IN_GROUP].sort(),
      );
      expect(pool?.mode).toBe('restricted');
    });

    it('should return null agentIds for an open channel with no pool — no restriction', async () => {
      channelRepo.findAll.mockResolvedValue([channel('ch1', { mode: 'open' })]);

      const pool = await service.resolvePool(TENANT, 'ch1');

      expect(pool?.agentIds).toBeNull();
    });

    it('should return null agentIds for an open channel even with a stale populated list', async () => {
      // H15: an 'open' channel must never let auto-routing narrow down to a
      // leftover userIds/groupIds list from a prior 'restricted' period —
      // mode is the single source of truth, not "is the list empty".
      channelRepo.findAll.mockResolvedValue([
        channel('ch1', {
          userIds: [AGENT_IN_POOL],
          groupIds: [GROUP_A],
          mode: 'open',
        }),
      ]);

      const pool = await service.resolvePool(TENANT, 'ch1');

      expect(pool?.agentIds).toBeNull();
    });

    it('should return an EMPTY pool for a restricted channel with no members', async () => {
      // The distinction that matters: [] admits nobody, null admits everyone.
      // Collapsing the two would silently open a channel that was locked down
      // and then emptied.
      channelRepo.findAll.mockResolvedValue([
        channel('ch1', { mode: 'restricted' }),
      ]);

      const pool = await service.resolvePool(TENANT, 'ch1');

      expect(pool?.agentIds).toEqual([]);
    });

    it('should resolve every channel in one group query, not one per channel', async () => {
      channelRepo.findAll.mockResolvedValue([
        channel('ch1', { groupIds: [GROUP_A], mode: 'restricted' }),
        channel('ch2', { groupIds: [GROUP_A], mode: 'restricted' }),
      ]);

      await service.resolvePool(TENANT, 'ch1');

      expect(groupModel.find).toHaveBeenCalledTimes(1);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Eligibility
  // ──────────────────────────────────────────────────────────────────────

  describe('assertAgentEligible', () => {
    beforeEach(() => {
      channelRepo.findAll.mockResolvedValue([
        channel('ch1', { userIds: [AGENT_IN_POOL], mode: 'restricted' }),
        channel('ch_open', { userIds: [AGENT_IN_POOL], mode: 'open' }),
      ]);
    });

    it('should admit an agent inside the pool', async () => {
      await expect(
        service.assertAgentEligible(TENANT, 'ch1', AGENT_IN_POOL),
      ).resolves.toBeUndefined();
    });

    it('should reject an agent outside the pool of a restricted channel', async () => {
      await expect(
        service.assertAgentEligible(TENANT, 'ch1', AGENT_OUTSIDE),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('should admit anyone on an open channel, even with a populated list', async () => {
      // 'open' makes the list a routing preference, not an access list.
      await expect(
        service.assertAgentEligible(TENANT, 'ch_open', AGENT_OUTSIDE),
      ).resolves.toBeUndefined();
    });

    it('should admit when the channel cannot be resolved', async () => {
      // A conversation whose channel was deleted must stay assignable;
      // failing closed here would strand it permanently.
      await expect(
        service.assertAgentEligible(TENANT, 'gone', AGENT_OUTSIDE),
      ).resolves.toBeUndefined();
    });

    it('should be a no-op when unassigning (null agent)', async () => {
      await expect(
        service.assertAgentEligible(TENANT, 'ch1', null),
      ).resolves.toBeUndefined();
    });
  });

  describe('assertGroupEligible', () => {
    beforeEach(() => {
      channelRepo.findAll.mockResolvedValue([
        channel('ch1', { groupIds: [GROUP_A], mode: 'restricted' }),
      ]);
    });

    it('should admit a group that serves the channel', async () => {
      await expect(
        service.assertGroupEligible(TENANT, 'ch1', GROUP_A),
      ).resolves.toBeUndefined();
    });

    it('should reject a group that does not', async () => {
      await expect(
        service.assertGroupEligible(TENANT, 'ch1', GROUP_B),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Visibility
  // ──────────────────────────────────────────────────────────────────────

  describe('listServableChannelIds', () => {
    it('should return null when no channel in the tenant restricts', async () => {
      // null skips the extra query clause entirely rather than listing every
      // channel — the common case must not cost a growing $in.
      channelRepo.findAll.mockResolvedValue([
        channel('ch1', { mode: 'open' }),
        channel('ch2', { mode: 'open' }),
      ]);

      await expect(
        service.listServableChannelIds(TENANT, AGENT_OUTSIDE),
      ).resolves.toBeNull();
    });

    it('should include open channels alongside restricted ones the user serves', async () => {
      channelRepo.findAll.mockResolvedValue([
        channel('ch_open', { mode: 'open' }),
        channel('ch_mine', { userIds: [AGENT_IN_POOL], mode: 'restricted' }),
        channel('ch_other', { userIds: [AGENT_OUTSIDE], mode: 'restricted' }),
      ]);

      const ids = await service.listServableChannelIds(TENANT, AGENT_IN_POOL);

      expect(ids?.sort()).toEqual(['ch_mine', 'ch_open']);
    });

    it('should admit a restricted channel through group membership', async () => {
      // L19: membership now comes solely from the pool's own resolved
      // agentIds (userIds ∪ actual group members), not a caller-supplied
      // group list — AGENT_IN_GROUP is a real member of GROUP_A per the
      // group lookup mock (`groupMembers`).
      channelRepo.findAll.mockResolvedValue([
        channel('ch_group', { groupIds: [GROUP_A], mode: 'restricted' }),
      ]);

      const ids = await service.listServableChannelIds(TENANT, AGENT_IN_GROUP);

      expect(ids).toEqual(['ch_group']);
    });

    it('should exclude a restricted channel from a user in none of its groups', async () => {
      channelRepo.findAll.mockResolvedValue([
        channel('ch_group', { groupIds: [GROUP_A], mode: 'restricted' }),
      ]);

      const ids = await service.listServableChannelIds(TENANT, AGENT_OUTSIDE);

      expect(ids).toEqual([]);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Write path
  // ──────────────────────────────────────────────────────────────────────

  describe('updateSupport', () => {
    beforeEach(() => {
      channelRepo.findById.mockResolvedValue(
        channel('ch1', { userIds: [AGENT_IN_POOL], mode: 'open' }),
      );
    });

    it('should leave omitted fields untouched', async () => {
      await service.updateSupport('ch1', { mode: 'restricted' });

      expect(channelRepo.update).toHaveBeenCalledWith(
        TENANT,
        'ch1',
        expect.objectContaining({
          support: expect.objectContaining({
            userIds: [AGENT_IN_POOL],
            mode: 'restricted',
          }),
        }),
      );
    });

    it('should dedupe repeated ids', async () => {
      await service.updateSupport('ch1', {
        userIds: [AGENT_IN_POOL, AGENT_IN_POOL],
      });

      const written = channelRepo.update.mock.calls[0][2].support;
      expect(written.userIds).toEqual([AGENT_IN_POOL]);
    });

    it('should reject a user that is not a member of the tenant', async () => {
      userModel.find.mockReturnValue(buildQuery([]));

      await expect(
        service.updateSupport('ch1', { userIds: [AGENT_OUTSIDE] }),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(channelRepo.update).not.toHaveBeenCalled();
    });

    it('should reject a group that does not exist in the tenant', async () => {
      groupModel.find.mockReturnValue(buildQuery([]));

      await expect(
        service.updateSupport('ch1', { groupIds: [GROUP_B] }),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(channelRepo.update).not.toHaveBeenCalled();
    });

    it('should drop the cached pool so the next read sees the new value', async () => {
      channelRepo.findAll.mockResolvedValue([
        channel('ch1', { userIds: [AGENT_IN_POOL], mode: 'restricted' }),
      ]);
      await service.resolvePool(TENANT, 'ch1');
      expect(channelRepo.findAll).toHaveBeenCalledTimes(1);

      await service.updateSupport('ch1', { mode: 'open' });
      await service.resolvePool(TENANT, 'ch1');

      expect(channelRepo.findAll).toHaveBeenCalledTimes(2);
    });
  });
});
