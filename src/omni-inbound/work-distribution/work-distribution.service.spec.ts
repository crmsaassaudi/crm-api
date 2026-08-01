import { ConflictException } from '@nestjs/common';
import { WorkDistributionService } from './work-distribution.service';

/** Minimal Mongoose query double: every builder call chains, `exec` resolves. */
const query = (value: any) => {
  const q: any = { exec: jest.fn().mockResolvedValue(value) };
  for (const builder of ['setOptions', 'select', 'limit', 'lean', 'sort']) {
    q[builder] = jest.fn().mockReturnValue(q);
  }
  return q;
};

describe('WorkDistributionService', () => {
  let workItems: any;
  let queueEntries: any;
  let offers: any;
  let conversations: any;
  let inboxes: any;
  let presence: any;
  let commands: any;
  let settings: any;
  let events: any;
  let service: WorkDistributionService;

  beforeEach(() => {
    workItems = {
      findOneAndUpdate: jest.fn(),
      updateOne: jest.fn().mockReturnValue(query({ modifiedCount: 1 })),
    };
    queueEntries = {
      findOneAndUpdate: jest.fn(),
      updateOne: jest.fn().mockReturnValue(query({ modifiedCount: 1 })),
      updateMany: jest.fn().mockReturnValue(query({ modifiedCount: 1 })),
    };
    offers = {
      create: jest.fn(),
      findOneAndUpdate: jest.fn(),
      updateOne: jest.fn().mockReturnValue(query({ modifiedCount: 1 })),
      find: jest.fn(),
    };
    conversations = { findOne: jest.fn() };
    inboxes = {
      findOne: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockReturnValue(query(null)),
        }),
      }),
    };
    presence = {
      reserveFirstEligibleAgent: jest.fn().mockResolvedValue('agent_1'),
      releaseConversation: jest.fn().mockResolvedValue(undefined),
    };
    commands = {
      executeAssignAgent: jest
        .fn()
        .mockResolvedValue({ assignedAgentId: 'agent_1' }),
    };
    settings = {
      getSetting: jest.fn().mockResolvedValue(null),
    };
    events = { emit: jest.fn() };
    service = new WorkDistributionService(
      workItems,
      queueEntries,
      offers,
      conversations,
      inboxes,
      presence,
      commands,
      events,
      settings,
      { acquire: (_k: any, _o: any, fn: any) => fn() } as any,
    );
  });

  it('should retains agent capacity during after-contact work', async () => {
    conversations.findOne.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockReturnValue(
          query({
            channelType: 'livechat',
            assignedAgentId: 'agent_1',
          }),
        ),
      }),
    });
    workItems.findOneAndUpdate.mockReturnValue(
      query({
        _id: 'work_1',
        assignedAgentId: 'agent_1',
      }),
    );

    await service.onConversationStatusChanged({
      tenantId: 'tenant_1',
      conversationId: 'conversation_1',
      status: 'resolved',
    });

    expect(workItems.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        status: { $in: ['queued', 'offered', 'assigned', 'active'] },
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          status: 'wrap_up',
          assignedAgentId: 'agent_1',
        }),
      }),
      { new: true },
    );
    expect(presence.releaseConversation).not.toHaveBeenCalled();
  });

  it('should creates a leased offer only after atomically reserving agent capacity', async () => {
    workItems.findOneAndUpdate.mockReturnValueOnce(
      query({ _id: 'work_1', tenantId: 'tenant_1' }),
    );
    queueEntries.findOneAndUpdate.mockReturnValueOnce(
      query({ _id: 'queue_1' }),
    );
    offers.create.mockResolvedValue({ _id: 'offer_1' });

    await service.createOffer({
      tenantId: 'tenant_1',
      workItemId: 'work_1',
      agentId: 'agent_1',
      leaseMs: 10_000,
    });

    expect(presence.reserveFirstEligibleAgent).toHaveBeenCalledWith(
      'tenant_1',
      ['agent_1'],
      undefined,
    );
    expect(offers.create).toHaveBeenCalledWith(
      expect.objectContaining({
        workItemId: 'work_1',
        queueEntryId: 'queue_1',
        agentId: 'agent_1',
        status: 'offered',
      }),
    );
  });

  it('should releases capacity when offer persistence fails', async () => {
    workItems.findOneAndUpdate.mockReturnValueOnce(
      query({ _id: 'work_1', tenantId: 'tenant_1' }),
    );
    queueEntries.findOneAndUpdate.mockReturnValueOnce(
      query({ _id: 'queue_1' }),
    );
    offers.create.mockRejectedValue(new Error('mongo unavailable'));

    await expect(
      service.createOffer({
        tenantId: 'tenant_1',
        workItemId: 'work_1',
        agentId: 'agent_1',
      }),
    ).rejects.toThrow('mongo unavailable');
    expect(presence.releaseConversation).toHaveBeenCalledWith(
      'tenant_1',
      'agent_1',
      undefined,
    );
  });

  it('should accepts an offer with CAS and enqueues the aggregate assignment command', async () => {
    offers.findOneAndUpdate.mockReturnValueOnce(
      query({
        _id: 'offer_1',
        workItemId: 'work_1',
        queueEntryId: 'queue_1',
      }),
    );
    workItems.findOneAndUpdate.mockReturnValueOnce(
      query({ _id: 'work_1', conversationId: 'conversation_1' }),
    );

    await expect(
      service.acceptOffer('tenant_1', 'offer_1', 'agent_1'),
    ).resolves.toEqual({
      offerId: 'offer_1',
      workItemId: 'work_1',
      status: 'accepted',
    });
    expect(commands.executeAssignAgent).toHaveBeenCalledWith(
      'conversation_1',
      'tenant_1',
      {
        agentId: 'agent_1',
        onlyIfUnassigned: true,
        reason: 'offer_accepted',
      },
    );
  });

  it('should rejects a stale or already answered offer', async () => {
    offers.findOneAndUpdate.mockReturnValueOnce(query(null));

    await expect(
      service.acceptOffer('tenant_1', 'offer_1', 'agent_1'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(commands.executeAssignAgent).not.toHaveBeenCalled();
  });

  it('should compensates reservation and state if assignment enqueue fails', async () => {
    offers.findOneAndUpdate.mockReturnValueOnce(
      query({
        _id: 'offer_1',
        workItemId: 'work_1',
        queueEntryId: 'queue_1',
      }),
    );
    workItems.findOneAndUpdate.mockReturnValueOnce(
      query({
        _id: 'work_1',
        conversationId: 'conversation_1',
      }),
    );
    commands.executeAssignAgent.mockRejectedValue(new Error('redis down'));

    await expect(
      service.acceptOffer('tenant_1', 'offer_1', 'agent_1'),
    ).rejects.toThrow('redis down');
    expect(presence.releaseConversation).toHaveBeenCalledWith(
      'tenant_1',
      'agent_1',
      undefined,
    );
    expect(offers.updateOne).toHaveBeenCalledWith(
      { _id: 'offer_1', status: 'accepted' },
      { $set: { status: 'cancelled' } },
    );
  });

  describe('re-offer after a lapsed offer', () => {
    const expiredOffer = {
      _id: 'offer_1',
      tenantId: 'tenant_1',
      agentId: 'agent_1',
      workItemId: 'work_1',
      queueEntryId: 'queue_1',
    };

    beforeEach(() => {
      offers.find.mockReturnValue(query([expiredOffer]));
      offers.findOneAndUpdate.mockReturnValue(query(expiredOffer));
    });

    it('should ask for another routing pass that skips the agent who lapsed', async () => {
      workItems.findOneAndUpdate.mockReturnValue(
        query({
          _id: 'work_1',
          conversationId: 'conversation_1',
          redispatchAttempts: 1,
        }),
      );

      await service.expireOffers();

      expect(events.emit).toHaveBeenCalledWith(
        'omni.work_item.requeued',
        expect.objectContaining({
          tenantId: 'tenant_1',
          conversationId: 'conversation_1',
          excludeAgentId: 'agent_1',
          attempt: 1,
        }),
      );
    });

    it('should stop re-offering once the attempt bound is reached', async () => {
      // The bounded update matches nothing when redispatchAttempts is spent.
      workItems.findOneAndUpdate.mockReturnValue(query(null));

      await service.expireOffers();

      expect(events.emit).not.toHaveBeenCalledWith(
        'omni.work_item.requeued',
        expect.anything(),
      );
    });
  });
});
