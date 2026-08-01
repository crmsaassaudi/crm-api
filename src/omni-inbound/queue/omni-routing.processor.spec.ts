import { OmniRoutingProcessor } from './omni-routing.processor';

describe('OmniRoutingProcessor', () => {
  let eventEmitter: { emitAsync: jest.Mock };
  let cls: { runWith: jest.Mock };
  let idempotency: { claim: jest.Mock; commit: jest.Mock };
  let processor: OmniRoutingProcessor;

  const payload = (overrides: Record<string, unknown> = {}): any => ({
    tenantId: 'tenant_1',
    channelType: 'facebook',
    channelId: 'channel_1',
    channelAccount: 'page_1',
    externalConversationId: 'thread_1',
    senderId: 'user_1',
    messageType: 'text',
    content: 'hello',
    externalMessageId: 'mid.1',
    ...overrides,
  });

  beforeEach(() => {
    eventEmitter = { emitAsync: jest.fn().mockResolvedValue([]) };
    cls = { runWith: jest.fn((context, callback) => callback()) };
    idempotency = {
      claim: jest.fn().mockResolvedValue(true),
      commit: jest.fn().mockResolvedValue(undefined),
    };
    processor = new OmniRoutingProcessor(
      eventEmitter as any,
      cls as any,
      idempotency as any,
    );
  });

  it('should emit omni.message.received inside tenant context', async () => {
    const data = payload();

    await processor.process({ id: 'job_1', data } as any);

    expect(cls.runWith).toHaveBeenCalledWith(
      { tenantId: 'tenant_1', activeTenantId: 'tenant_1' },
      expect.any(Function),
    );
    expect(eventEmitter.emitAsync).toHaveBeenCalledWith(
      'omni.message.received',
      data,
    );
  });

  it('should claim before emitting and commit only after', async () => {
    const order: string[] = [];
    idempotency.claim.mockImplementation(() => {
      order.push('claim');
      return Promise.resolve(true);
    });
    eventEmitter.emitAsync.mockImplementation(() => {
      order.push('emit');
      return Promise.resolve([]);
    });
    idempotency.commit.mockImplementation(() => {
      order.push('commit');
      return Promise.resolve();
    });

    await processor.process({ id: 'job_1', data: payload() } as any);

    expect(order).toEqual(['claim', 'emit', 'commit']);
  });

  it('should not commit when a listener throws, so the retry reprocesses', async () => {
    eventEmitter.emitAsync.mockRejectedValueOnce(new Error('listener failed'));

    await expect(
      processor.process({ id: 'job_1', data: payload() } as any),
    ).rejects.toThrow('listener failed');

    expect(idempotency.commit).not.toHaveBeenCalled();
  });

  it('should skip a message whose claim is already held', async () => {
    idempotency.claim.mockResolvedValueOnce(false);

    await processor.process({ id: 'job_1', data: payload() } as any);

    expect(eventEmitter.emitAsync).not.toHaveBeenCalled();
  });

  it('should give messages with no provider id distinct dedup keys', async () => {
    await processor.process({
      id: 'job_1',
      data: payload({ externalMessageId: '', content: 'first' }),
    } as any);
    await processor.process({
      id: 'job_2',
      data: payload({ externalMessageId: '', content: 'second' }),
    } as any);

    const [firstKey] = idempotency.claim.mock.calls[0];
    const [secondKey] = idempotency.claim.mock.calls[1];

    // Interpolating an empty externalMessageId collapsed every id-less message
    // in the tenant onto `omni:dedup:<tenant>:`, so only the first survived.
    expect(firstKey).not.toEqual(secondKey);
    expect(firstKey).toMatch(/^omni:dedup:tenant_1:synthetic:/);
    expect(eventEmitter.emitAsync).toHaveBeenCalledTimes(2);
  });
});
