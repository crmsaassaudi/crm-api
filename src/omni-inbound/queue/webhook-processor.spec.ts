import { WebhookProcessor, WebhookJobData } from './webhook-processor';

describe('WebhookProcessor', () => {
  let processorService: { process: jest.Mock };
  let channelsService: { findAnyByAccount: jest.Mock };
  let contactRepo: { isVIPSender: jest.Mock };
  let cls: { runWith: jest.Mock };
  let redis: { set: jest.Mock; del: jest.Mock };
  let processor: WebhookProcessor;

  beforeEach(() => {
    processorService = { process: jest.fn().mockResolvedValue(undefined) };
    channelsService = {
      findAnyByAccount: jest.fn().mockResolvedValue({
        id: 'channel_1',
        tenantId: 'tenant_1',
      }),
    };
    contactRepo = { isVIPSender: jest.fn().mockResolvedValue(false) };
    cls = { runWith: jest.fn((context, callback) => callback()) };
    redis = {
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
    };

    processor = new WebhookProcessor(
      processorService as any,
      channelsService as any,
      contactRepo as any,
      cls as any,
      redis as any,
    );
  });

  it('should skip duplicates before channel lookup', async () => {
    redis.set.mockResolvedValueOnce(null);

    await processor.process(createJob('page_1') as any);

    expect(redis.set).toHaveBeenCalledWith(
      'processed:webhook:facebook:page_1:mid.1',
      '1',
      'EX',
      86400,
      'NX',
    );
    expect(channelsService.findAnyByAccount).not.toHaveBeenCalled();
    expect(processorService.process).not.toHaveBeenCalled();
  });

  it('should scope provider message id by account id', async () => {
    await processor.process(createJob('page_a') as any);
    await processor.process(createJob('page_b') as any);

    expect(redis.set).toHaveBeenNthCalledWith(
      1,
      'processed:webhook:facebook:page_a:mid.1',
      '1',
      'EX',
      86400,
      'NX',
    );
    expect(redis.set).toHaveBeenNthCalledWith(
      2,
      'processed:webhook:facebook:page_b:mid.1',
      '1',
      'EX',
      86400,
      'NX',
    );
  });

  it('should skip Redis dedup when provider message id is missing', async () => {
    await processor.process({
      id: 'job_123',
      data: {
        channelType: 'facebook',
        accountId: 'page_1',
        event: { sender: { id: 'sender_1' }, recipient: { id: 'page_1' } },
      },
    } as any);

    // When no provider message ID exists, dedup is skipped entirely
    // (falling back to job.id would silently allow duplicates on retry)
    expect(redis.set).not.toHaveBeenCalled();
    // But message should still be processed
    expect(processorService.process).toHaveBeenCalled();
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
