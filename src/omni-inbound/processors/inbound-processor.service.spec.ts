import { EventEmitter2 } from '@nestjs/event-emitter';
import { InboundProcessorService } from './inbound-processor.service';
import { FacebookAdapter } from '../adapters/facebook.adapter';
import { ZaloAdapter } from '../adapters/zalo.adapter';
import { WhatsAppAdapter } from '../adapters/whatsapp.adapter';
import { ChannelType } from '../domain/omni-payload';
import { ChannelAdapter } from '../adapters/channel-adapter.interface';

describe('InboundProcessorService', () => {
  let service: InboundProcessorService;
  let eventEmitter: EventEmitter2;
  let adapters: Map<ChannelType, ChannelAdapter>;

  beforeEach(() => {
    eventEmitter = new EventEmitter2();
    jest.spyOn(eventEmitter, 'emit');

    adapters = new Map<ChannelType, ChannelAdapter>();
    adapters.set('facebook', new FacebookAdapter());
    adapters.set('zalo', new ZaloAdapter());
    adapters.set('whatsapp', new WhatsAppAdapter());

    service = new InboundProcessorService(adapters, eventEmitter);
  });

  it('should route a Facebook payload to the Facebook adapter', async () => {
    const raw = {
      sender: { id: 'psid_123' },
      recipient: { id: 'page_456' },
      timestamp: 1700000000000,
      message: { mid: 'mid.abc', text: 'Hello FB!' },
    };

    const result = await service.process('facebook', raw, 'tenant_1', 'ch_1');

    expect(result.channelType).toBe('facebook');
    expect(result.content).toBe('Hello FB!');
    expect(eventEmitter.emit).toHaveBeenCalledWith(
      'omni.message.received',
      expect.objectContaining({ channelType: 'facebook' }),
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

    expect(result.channelType).toBe('zalo');
    expect(result.content).toBe('Hello Zalo!');
    expect(eventEmitter.emit).toHaveBeenCalledWith(
      'omni.message.received',
      expect.objectContaining({ channelType: 'zalo' }),
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

    expect(result.channelType).toBe('whatsapp');
    expect(result.content).toBe('Hello WA!');
    expect(eventEmitter.emit).toHaveBeenCalledWith(
      'omni.message.received',
      expect.objectContaining({ channelType: 'whatsapp' }),
    );
  });

  it('should throw for an unknown channel type', async () => {
    await expect(
      service.process('telegram' as ChannelType, {}, 'tenant_1', 'ch_99'),
    ).rejects.toThrow('No adapter registered for channel type: telegram');
  });

  it('should emit omni.message.received event on successful processing', async () => {
    const raw = {
      sender: { id: 'psid_123' },
      recipient: { id: 'page_456' },
      timestamp: 1700000000000,
      message: { mid: 'mid.event', text: 'Event test' },
    };

    await service.process('facebook', raw, 'tenant_1', 'ch_1');

    expect(eventEmitter.emit).toHaveBeenCalledTimes(1);
    expect(eventEmitter.emit).toHaveBeenCalledWith(
      'omni.message.received',
      expect.objectContaining({
        content: 'Event test',
        externalMessageId: 'mid.event',
      }),
    );
  });
});
