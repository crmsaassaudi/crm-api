import { ForbiddenException } from '@nestjs/common';
import { ConversationTransferService } from './conversation-transfer.service';

const query = (value: any) => ({ exec: jest.fn().mockResolvedValue(value) });

describe('ConversationTransferService', () => {
  let transfers: any;
  let conversations: any;
  let commands: any;
  let presence: any;
  let channelSupport: any;
  let events: any;
  let service: ConversationTransferService;

  const document = (overrides: Record<string, any> = {}) => ({
    _id: 'transfer_1',
    tenantId: 'tenant_1',
    conversationId: 'conversation_1',
    type: 'warm',
    sourceAgentId: 'agent_source',
    targetAgentId: 'agent_target',
    targetGroupId: null,
    status: 'requested',
    expiresAt: new Date(Date.now() + 60_000),
    consultCapacityReserved: false,
    save: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  });

  beforeEach(() => {
    transfers = {
      create: jest.fn(),
      findOneAndUpdate: jest.fn(),
      findOne: jest.fn(),
      updateOne: jest.fn().mockReturnValue(query({ modifiedCount: 1 })),
      find: jest.fn(),
    };
    conversations = {
      findById: jest.fn().mockResolvedValue({
        id: 'conversation_1',
        tenantId: 'tenant_1',
        channelId: 'channel_1',
        channelType: 'facebook',
        assignedAgentId: 'agent_source',
      }),
    };
    commands = {
      executeAssignAgent: jest.fn().mockResolvedValue({
        assignedAgentId: 'agent_target',
      }),
    };
    presence = {
      claimIfUnderCapacity: jest.fn().mockResolvedValue(true),
      releaseConversation: jest.fn().mockResolvedValue(undefined),
    };
    channelSupport = {
      assertAgentEligible: jest.fn().mockResolvedValue(undefined),
    };
    events = { emit: jest.fn() };
    service = new ConversationTransferService(
      transfers,
      conversations,
      commands,
      presence,
      channelSupport,
      events,
      { acquire: (_k: any, _o: any, fn: any) => fn() } as any,
      // Only consulted when the actor is NOT the assignee — a supervisor moving
      // work off someone else. Grants nothing by default so the assignee-only
      // cases below still exercise the original rule.
      { explainForUser: jest.fn().mockResolvedValue({ effective: [] }) } as any,
    );
  });

  it('should allows only the current assignee to initiate a transfer', async () => {
    await expect(
      service.create('tenant_1', 'conversation_1', 'agent_other', {
        type: 'warm',
        targetAgentId: 'agent_target',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(transfers.create).not.toHaveBeenCalled();
  });

  it('should completes a cold transfer immediately through the aggregate command', async () => {
    const transfer = document({ type: 'cold', status: 'accepted' });
    transfers.create.mockResolvedValue(transfer);

    await service.create('tenant_1', 'conversation_1', 'agent_source', {
      type: 'cold',
      targetAgentId: 'agent_target',
      handoffNote: 'Customer needs billing',
    });

    expect(channelSupport.assertAgentEligible).toHaveBeenCalledWith(
      'tenant_1',
      'channel_1',
      'agent_target',
    );
    expect(presence.claimIfUnderCapacity).toHaveBeenCalledWith(
      'tenant_1',
      'agent_target',
      undefined,
    );
    expect(commands.executeAssignAgent).toHaveBeenCalledWith(
      'conversation_1',
      'tenant_1',
      expect.objectContaining({
        agentId: 'agent_target',
        previousAgentId: 'agent_source',
        reason: 'transfer_cold',
        syncCapacity: { releaseAgentId: 'agent_source' },
      }),
    );
    expect(transfer.status).toBe('completed');
  });

  it('should does not change ownership until a warm transfer is accepted', async () => {
    const transfer = document({ type: 'warm' });
    transfers.create.mockResolvedValue(transfer);
    await service.create('tenant_1', 'conversation_1', 'agent_source', {
      type: 'warm',
      targetAgentId: 'agent_target',
    });
    expect(commands.executeAssignAgent).not.toHaveBeenCalled();

    transfers.findOneAndUpdate.mockReturnValueOnce(query(transfer));
    await service.accept('tenant_1', 'transfer_1', 'agent_target');

    expect(commands.executeAssignAgent).toHaveBeenCalled();
    expect(transfer.status).toBe('completed');
  });

  it('should starts consult collaboration without changing conversation ownership', async () => {
    const transfer = document({ type: 'consult' });
    transfers.findOneAndUpdate.mockReturnValueOnce(query(transfer));

    await service.accept('tenant_1', 'transfer_1', 'agent_target');

    expect(transfer.status).toBe('consulting');
    expect(transfer.consultCapacityReserved).toBe(true);
    expect(commands.executeAssignAgent).not.toHaveBeenCalled();
  });

  it('should releases consult capacity when consultation ends without ownership transfer', async () => {
    const transfer = document({
      type: 'consult',
      status: 'consulting',
      consultCapacityReserved: true,
    });
    transfers.findOne.mockReturnValueOnce(query(transfer));

    await service.completeConsult(
      'tenant_1',
      'transfer_1',
      'agent_source',
      false,
    );

    expect(presence.releaseConversation).toHaveBeenCalledWith(
      'tenant_1',
      'agent_target',
      undefined,
    );
    expect(transfer.status).toBe('completed');
  });

  it('should compensates target capacity when accepted ownership loses its CAS', async () => {
    const transfer = document({ type: 'warm' });
    transfers.findOneAndUpdate.mockReturnValueOnce(query(transfer));
    commands.executeAssignAgent.mockResolvedValue({
      assignedAgentId: 'agent_someone_else',
    });

    await expect(
      service.accept('tenant_1', 'transfer_1', 'agent_target'),
    ).rejects.toThrow('Conversation ownership changed');
    expect(presence.releaseConversation).toHaveBeenCalledWith(
      'tenant_1',
      'agent_target',
      undefined,
    );
    expect(transfer.status).toBe('cancelled');
  });
});
