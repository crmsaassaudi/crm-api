import { PayloadTooLargeException } from '@nestjs/common';
import { InboundController } from './inbound.controller';

describe('InboundController webhook payload limits', () => {
  const processor = {
    validateWebhook: jest.fn().mockReturnValue(true),
  };
  const queue = {
    addBulk: jest.fn().mockResolvedValue(undefined),
  };
  const config = {
    get: jest.fn((key: string) => {
      if (key === 'OMNI_WEBHOOK_MAX_PAYLOAD_BYTES') return '10';
      return undefined;
    }),
  };

  let controller: InboundController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new InboundController(
      processor as any,
      config as any,
      queue as any,
    );
  });

  it('should reject an oversized raw webhook before signature work or enqueue', async () => {
    const request = { rawBody: Buffer.alloc(11) } as any;

    await expect(
      controller.receiveWebhook('facebook', {}, { entry: [] }, request),
    ).rejects.toBeInstanceOf(PayloadTooLargeException);

    expect(processor.validateWebhook).not.toHaveBeenCalled();
    expect(queue.addBulk).not.toHaveBeenCalled();
  });

  it('should accepts a payload at the configured limit', async () => {
    const request = { rawBody: Buffer.alloc(10) } as any;

    await expect(
      controller.receiveWebhook('facebook', {}, { entry: [] }, request),
    ).resolves.toEqual({ status: 'ok', queued: 0 });

    expect(processor.validateWebhook).toHaveBeenCalled();
    expect(queue.addBulk).toHaveBeenCalledWith([]);
  });
});
