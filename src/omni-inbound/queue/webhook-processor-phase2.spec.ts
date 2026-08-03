import { NotFoundException } from '@nestjs/common';
import { WebhookProcessor } from './webhook-processor';

/**
 * WebhookProcessor — Phase 2 comprehensive tests
 *
 * Existing tests cover basic dedup and key scoping.
 * These tests cover:
 * - E11000 swallowing (Mongo duplicate key during processing → ack, don't retry)
 * - NotFoundException (channel deleted → ack, don't retry, but count the drop)
 * - Idempotency claims surviving unexpected errors so the retry can resume
 * - VIP sender detection
 * - Pre-resolved channel data path
 * - Provider message ID extraction across channel types
 * - No-dedup when provider message ID is missing
 */
describe('WebhookProcessor — error handling & edge cases', () => {
  let processor: WebhookProcessor;
  let processorService: { process: jest.Mock };
  let channelsService: { findAnyByAccount: jest.Mock };
  let contactRepo: { isVIPSender: jest.Mock };
  let cls: { runWith: jest.Mock };
  let idempotency: { claim: jest.Mock; commit: jest.Mock; release: jest.Mock };
  let metrics: { incrementCounter: jest.Mock };

  beforeEach(() => {
    processorService = { process: jest.fn().mockResolvedValue([]) };
    channelsService = {
      findAnyByAccount: jest.fn().mockResolvedValue({
        id: 'channel_1',
        tenantId: 'tenant_1',
      }),
    };
    contactRepo = { isVIPSender: jest.fn().mockResolvedValue(false) };
    cls = { runWith: jest.fn((_context, callback) => callback()) };
    idempotency = {
      claim: jest.fn().mockResolvedValue(true),
      commit: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
    };
    metrics = { incrementCounter: jest.fn() };

    processor = new WebhookProcessor(
      processorService as any,
      channelsService as any,
      contactRepo as any,
      cls as any,
      idempotency as any,
      metrics as any,
    );
  });

  // E11000 — Mongo duplicate key → swallow, don't retry
  describe('MongoDB duplicate key (E11000)', () => {
    it('should swallow E11000 and not throw (prevents BullMQ retry)', async () => {
      const e11000 = new Error('E11000 duplicate key');
      (e11000 as any).code = 11000;
      processorService.process.mockRejectedValueOnce(e11000);

      // Should NOT throw — BullMQ interprets throw as "retry"
      await expect(
        processor.process(createFacebookJob()),
      ).resolves.toBeUndefined();
    });

    it('should commit the claim on E11000 (message was already persisted)', async () => {
      const e11000 = new Error('E11000');
      (e11000 as any).code = 11000;
      processorService.process.mockRejectedValueOnce(e11000);

      await processor.process(createFacebookJob());

      // The work is done, so the claim becomes a permanent duplicate marker.
      expect(idempotency.commit).toHaveBeenCalled();
      expect(idempotency.release).not.toHaveBeenCalled();
    });
  });

  // NotFoundException — channel deleted → swallow, don't retry
  describe('NotFoundException (channel deleted)', () => {
    it('should not throw for a channel that no longer exists', async () => {
      channelsService.findAnyByAccount.mockRejectedValueOnce(
        new NotFoundException('Channel not found'),
      );

      await expect(
        processor.process(createFacebookJob()),
      ).resolves.toBeUndefined();
    });

    it('should not process the message when channel is not found', async () => {
      channelsService.findAnyByAccount.mockRejectedValueOnce(
        new NotFoundException('Channel deleted'),
      );

      await processor.process(createFacebookJob());

      expect(processorService.process).not.toHaveBeenCalled();
    });
  });

  // Unexpected errors — release Redis lock, re-throw for retry
  describe('unexpected errors', () => {
    it('should re-throw unexpected errors for BullMQ retry', async () => {
      processorService.process.mockRejectedValueOnce(
        new Error('Adapter timeout'),
      );

      await expect(processor.process(createFacebookJob())).rejects.toThrow(
        'Adapter timeout',
      );
    });

    it('should leave the claim in place on unexpected error', async () => {
      processorService.process.mockRejectedValueOnce(
        new Error('Network error'),
      );

      await expect(processor.process(createFacebookJob())).rejects.toThrow();

      // The retry runs under the same owner and re-enters its own claim, so
      // nothing has to be released — and a release here would let a concurrent
      // redelivery process the same message twice.
      expect(idempotency.release).not.toHaveBeenCalled();
      expect(idempotency.commit).not.toHaveBeenCalled();
    });
  });

  // Pre-resolved channel data — bypass channelsService lookup
  describe('pre-resolved channel data', () => {
    it('should skip channelsService.findAnyByAccount when data is pre-resolved', async () => {
      await processor.process({
        id: 'job_pre',
        data: {
          channelType: 'facebook',
          accountId: 'page_1',
          tenantId: 'tenant_pre',
          channelId: 'channel_pre',
          channelConfig: { some: 'config' },
          event: {
            sender: { id: 'sender_1' },
            recipient: { id: 'page_1' },
            message: { mid: 'mid.pre', text: 'hello' },
          },
        },
      } as any);

      // Channel lookup should NOT be called
      expect(channelsService.findAnyByAccount).not.toHaveBeenCalled();
      // But processor should be called with the pre-resolved data
      expect(processorService.process).toHaveBeenCalledWith(
        'facebook',
        expect.anything(),
        'tenant_pre',
        'channel_pre',
        { some: 'config' },
      );
    });
  });

  // No provider message ID → skip dedup entirely
  describe('missing provider message ID', () => {
    it('should skip Redis dedup when event has no extractable message ID', async () => {
      await processor.process({
        id: 'job_no_mid',
        data: {
          channelType: 'facebook',
          accountId: 'page_1',
          event: {
            sender: { id: 'sender_1' },
            recipient: { id: 'page_1' },
            // No message.mid field
          },
        },
      } as any);

      // No idempotency key can be built, so no claim is taken.
      expect(idempotency.claim).not.toHaveBeenCalled();
      // But should still process the message
      expect(processorService.process).toHaveBeenCalled();
    });
  });

  // Multi-channel provider message ID extraction
  describe('provider message ID extraction', () => {
    it('should extract mid from WhatsApp message format', async () => {
      await processor.process({
        id: 'job_wa',
        data: {
          channelType: 'whatsapp',
          accountId: 'wa_phone_1',
          event: {
            metadata: { phone_number_id: 'wa_phone_1' },
            messages: [{ id: 'wamid.abc123', from: '84xxx' }],
          },
        },
      } as any);

      expect(idempotency.claim).toHaveBeenCalledWith(
        'processed:webhook:whatsapp:wa_phone_1:wamid.abc123',
        'job_wa',
      );
    });

    it('should extract msg_id from Zalo message format', async () => {
      await processor.process({
        id: 'job_zalo',
        data: {
          channelType: 'zalo',
          accountId: 'oa_1',
          event: {
            sender: { id: 'zalo_sender' },
            recipient: { id: 'oa_1' },
            message: { msg_id: 'zalo_msg_1', text: 'xin chào' },
          },
        },
      } as any);

      expect(idempotency.claim).toHaveBeenCalledWith(
        'processed:webhook:zalo:oa_1:zalo_msg_1',
        'job_zalo',
      );
    });
  });

  // VIP sender detection
  describe('VIP sender', () => {
    it('should check VIP status for sender', async () => {
      contactRepo.isVIPSender.mockResolvedValueOnce(true);

      await processor.process(createFacebookJob());

      expect(contactRepo.isVIPSender).toHaveBeenCalledWith(
        'tenant_1',
        'sender_1',
      );
    });

    it('should not fail processing when VIP check errors', async () => {
      contactRepo.isVIPSender.mockRejectedValueOnce(new Error('DB down'));

      // Should still complete processing
      await expect(
        processor.process(createFacebookJob()),
      ).resolves.toBeUndefined();
      expect(processorService.process).toHaveBeenCalled();
    });
  });

  // Helpers
  function createFacebookJob() {
    return {
      id: 'job_fb_1',
      data: {
        channelType: 'facebook' as const,
        accountId: 'page_1',
        event: {
          sender: { id: 'sender_1' },
          recipient: { id: 'page_1' },
          message: { mid: 'mid.1', text: 'hello' },
        },
      },
    } as any;
  }
});
