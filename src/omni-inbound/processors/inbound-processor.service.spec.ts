import { InboundProcessorService } from './inbound-processor.service';
import { FacebookAdapter } from '../adapters/facebook.adapter';
import { ZaloAdapter } from '../adapters/zalo.adapter';
import { WhatsAppAdapter } from '../adapters/whatsapp.adapter';
import { ChannelType } from '../domain/omni-payload';
import { ChannelAdapter } from '../adapters/channel-adapter.interface';

describe('InboundProcessorService', () => {
  let service: InboundProcessorService;
  let routingQueue: { add: jest.Mock };
  let adapters: Map<ChannelType, ChannelAdapter>;

  beforeEach(() => {
    routingQueue = { add: jest.fn().mockResolvedValue({ id: 'route_1' }) };

    // WhatsAppAdapter requires WhatsAppTemplateRepository — pass a minimal mock
    const mockWaTemplateRepo = { updateByName: jest.fn() } as any;

    adapters = new Map<ChannelType, ChannelAdapter>();
    adapters.set('facebook', new FacebookAdapter());
    adapters.set('zalo', new ZaloAdapter());
    adapters.set('whatsapp', new WhatsAppAdapter(mockWaTemplateRepo));

    service = new InboundProcessorService(
      adapters,
      routingQueue as any,
      { emit: jest.fn() } as any,
    );
  });

  it('should route a Facebook payload to the Facebook adapter', async () => {
    const raw = {
      sender: { id: 'psid_123' },
      recipient: { id: 'page_456' },
      timestamp: 1700000000000,
      message: { mid: 'mid.abc', text: 'Hello FB!' },
    };

    const result = await service.process('facebook', raw, 'tenant_1', 'ch_1');

    expect(result!.channelType).toBe('facebook');
    expect(result!.content).toBe('Hello FB!');
    expect(routingQueue.add).toHaveBeenCalledWith(
      'omni.route',
      expect.objectContaining({ channelType: 'facebook' }),
      expect.objectContaining({ jobId: expect.any(String), priority: 10 }),
    );
  });

  it('should route a Zalo payload to the Zalo adapter', async () => {
    const raw = {
      app_id: 'app_001',
      sender: { id: 'zu_123' },
      recipient: { id: 'oa_456' },
      event_name: 'user_send_text',
      message: { msg_id: 'z001', text: 'Hello Zalo!' },
      timestamp: '1700000000000',
    };

    const result = await service.process('zalo', raw, 'tenant_1', 'ch_2');

    expect(result!.channelType).toBe('zalo');
    expect(result!.content).toBe('Hello Zalo!');
    expect(routingQueue.add).toHaveBeenCalledWith(
      'omni.route',
      expect.objectContaining({ channelType: 'zalo' }),
      expect.objectContaining({ jobId: expect.any(String), priority: 10 }),
    );
  });

  it('should route a WhatsApp payload to the WhatsApp adapter', async () => {
    const raw = {
      messaging_product: 'whatsapp',
      metadata: { phone_number_id: 'ph_123' },
      contacts: [{ profile: { name: 'Test' }, wa_id: 'wa_001' }],
      messages: [
        {
          from: 'wa_001',
          id: 'wamid.001',
          timestamp: '1700000000',
          type: 'text',
          text: { body: 'Hello WA!' },
        },
      ],
    };

    const result = await service.process('whatsapp', raw, 'tenant_1', 'ch_3');

    expect(result!.channelType).toBe('whatsapp');
    expect(result!.content).toBe('Hello WA!');
    expect(routingQueue.add).toHaveBeenCalledWith(
      'omni.route',
      expect.objectContaining({ channelType: 'whatsapp' }),
      expect.objectContaining({ jobId: expect.any(String), priority: 10 }),
    );
  });

  it('should throw for an unknown channel type', async () => {
    await expect(
      service.process('telegram' as ChannelType, {}, 'tenant_1', 'ch_99'),
    ).rejects.toThrow('No adapter registered for channel type: telegram');
  });

  it('should enqueue omni routing job on successful processing', async () => {
    const raw = {
      sender: { id: 'psid_123' },
      recipient: { id: 'page_456' },
      timestamp: 1700000000000,
      message: { mid: 'mid.event', text: 'Event test' },
    };

    await service.process('facebook', raw, 'tenant_1', 'ch_1');

    expect(routingQueue.add).toHaveBeenCalledTimes(1);
    expect(routingQueue.add).toHaveBeenCalledWith(
      'omni.route',
      expect.objectContaining({
        content: 'Event test',
        externalMessageId: 'mid.event',
      }),
      expect.objectContaining({ jobId: expect.any(String), priority: 10 }),
    );
  });
});
