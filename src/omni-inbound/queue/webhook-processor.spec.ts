import { NotFoundException } from '@nestjs/common';
import { WebhookProcessor, WebhookJobData } from './webhook-processor';

describe('WebhookProcessor', () => {
  let processorService: { process: jest.Mock };
  let channelsService: { findAnyByAccount: jest.Mock };
  let contactRepo: { isVIPSender: jest.Mock };
  let cls: { runWith: jest.Mock };
  let idempotency: { claim: jest.Mock; commit: jest.Mock; release: jest.Mock };
  let metrics: { incrementCounter: jest.Mock };
  let processor: WebhookProcessor;

  beforeEach(() => {
    processorService = { process: jest.fn().mockResolvedValue([]) };
    channelsService = {
      findAnyByAccount: jest.fn().mockResolvedValue({
        id: 'channel_1',
        tenantId: 'tenant_1',
      }),
    };
    contactRepo = { isVIPSender: jest.fn().mockResolvedValue(false) };
    cls = { runWith: jest.fn((context, callback) => callback()) };
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

  it('should skip duplicates before channel lookup', async () => {
    idempotency.claim.mockResolvedValueOnce(false);

    await processor.process(createJob('page_1') as any);

    expect(idempotency.claim).toHaveBeenCalledWith(
      'processed:webhook:facebook:page_1:mid.1',
      'job_page_1',
    );
    expect(channelsService.findAnyByAccount).not.toHaveBeenCalled();
    expect(processorService.process).not.toHaveBeenCalled();
  });

  it('should scope provider message id by account id', async () => {
    await processor.process(createJob('page_a') as any);
    await processor.process(createJob('page_b') as any);

    expect(idempotency.claim).toHaveBeenNthCalledWith(
      1,
      'processed:webhook:facebook:page_a:mid.1',
      'job_page_a',
    );
    expect(idempotency.claim).toHaveBeenNthCalledWith(
      2,
      'processed:webhook:facebook:page_b:mid.1',
      'job_page_b',
    );
  });

  it('should skip dedup when provider message id is missing', async () => {
    await processor.process({
      id: 'job_123',
      data: {
        channelType: 'facebook',
        accountId: 'page_1',
        event: { sender: { id: 'sender_1' }, recipient: { id: 'page_1' } },
      },
    } as any);

    // Falling back to job.id would silently allow duplicates on retry.
    expect(idempotency.claim).not.toHaveBeenCalled();
    expect(processorService.process).toHaveBeenCalled();
  });

  it('should only commit the claim once the message is processed', async () => {
    const order: string[] = [];
    processorService.process.mockImplementation(() => {
      order.push('process');
      return Promise.resolve([]);
    });
    idempotency.commit.mockImplementation(() => {
      order.push('commit');
      return Promise.resolve();
    });

    await processor.process(createJob('page_1') as any);

    expect(order).toEqual(['process', 'commit']);
  });

  it('should leave the claim uncommitted when processing throws', async () => {
    processorService.process.mockRejectedValueOnce(new Error('mongo down'));

    await expect(processor.process(createJob('page_1') as any)).rejects.toThrow(
      'mongo down',
    );

    // The retry re-enters its own claim; committing here would have made the
    // retry look like a duplicate and dropped the message.
    expect(idempotency.commit).not.toHaveBeenCalled();
    expect(idempotency.release).not.toHaveBeenCalled();
  });

  it('should release the claim and count the drop when the channel is gone', async () => {
    channelsService.findAnyByAccount.mockRejectedValueOnce(
      new NotFoundException('Channel not found'),
    );

    await processor.process(createJob('page_1') as any);

    expect(idempotency.release).toHaveBeenCalledWith(
      'processed:webhook:facebook:page_1:mid.1',
    );
    expect(metrics.incrementCounter).toHaveBeenCalledWith(
      'crm_omni_webhooks_dropped_total',
      { channel: 'facebook', reason: 'channel_not_found' },
    );
  });

  function createJob(accountId: string): { id: string; data: WebhookJobData } {
    return {
      id: `job_${accountId}`,
      data: {
        channelType: 'facebook',
        accountId,
        event: {
          sender: { id: 'sender_1' },
          recipient: { id: accountId },
          message: { mid: 'mid.1', text: 'hello' },
        },
      },
    };
  }
});
