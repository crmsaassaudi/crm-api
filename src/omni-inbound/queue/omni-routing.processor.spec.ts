import { OmniRoutingProcessor } from './omni-routing.processor';

describe('OmniRoutingProcessor', () => {
  it('should emit omni.message.received inside tenant context', async () => {
    const eventEmitter = { emitAsync: jest.fn().mockResolvedValue([]) };
    const cls = { runWith: jest.fn((context, callback) => callback()) };
    const processor = new OmniRoutingProcessor(eventEmitter as any, cls as any);
    const payload: any = {
      tenantId: 'tenant_1',
      channelType: 'facebook',
      channelAccount: 'page_1',
      externalMessageId: 'mid.1',
    };

    await processor.process({ data: payload } as any);

    expect(cls.runWith).toHaveBeenCalledWith(
      { tenantId: 'tenant_1', activeTenantId: 'tenant_1' },
      expect.any(Function),
    );
    expect(eventEmitter.emitAsync).toHaveBeenCalledWith(
      'omni.message.received',
      payload,
    );
  });
});
