import { DeliveryCommandService } from './delivery-command.service';

describe('DeliveryCommandService', () => {
  let model: any;
  let queue: any;
  let service: DeliveryCommandService;

  beforeEach(() => {
    const command = { _id: 'command_1', tenantId: 'tenant_1' };
    model = {
      findOneAndUpdate: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue(command),
      }),
      find: jest.fn(),
      updateOne: jest.fn(),
    };
    queue = {
      add: jest.fn().mockResolvedValue({ id: 'command_1' }),
    };
    service = new DeliveryCommandService(model, queue, {
      incrementCounter: jest.fn(),
    } as any);
  });

  it('should persists a command before enqueueing a deterministic job', async () => {
    const input = {
      tenantId: 'tenant_1',
      messageId: 'message_1',
      conversationId: 'conversation_1',
      agentId: 'agent_1',
      content: 'hello',
      messageType: 'text',
      source: 'agent_ui',
      transport: 'socket' as const,
    };

    await expect(service.enqueue(input)).resolves.toEqual({
      commandId: 'command_1',
      deferred: false,
    });
    expect(model.findOneAndUpdate).toHaveBeenCalledWith(
      { tenantId: 'tenant_1', messageId: 'message_1' },
      {
        $setOnInsert: {
          ...input,
          kind: 'text',
          payload: {},
          status: 'pending',
        },
      },
      { upsert: true, new: true },
    );
    expect(queue.add).toHaveBeenCalledWith(
      'deliver-message',
      { commandId: 'command_1', tenantId: 'tenant_1' },
      expect.objectContaining({ jobId: 'command_1', attempts: 1 }),
    );
  });

  it('should returns deferred when Redis enqueue fails after durable persistence', async () => {
    queue.add.mockRejectedValue(new Error('redis unavailable'));

    await expect(
      service.enqueue({
        tenantId: 'tenant_1',
        messageId: 'message_1',
        conversationId: 'conversation_1',
        agentId: 'agent_1',
        content: 'hello',
        messageType: 'text',
        source: 'crm_api',
        transport: 'http',
      }),
    ).resolves.toEqual({ commandId: 'command_1', deferred: true });
  });
});
