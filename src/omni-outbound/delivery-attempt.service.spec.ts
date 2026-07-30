import { DeliveryAttemptService } from './delivery-attempt.service';

describe('DeliveryAttemptService', () => {
  let model: any;
  let service: DeliveryAttemptService;

  beforeEach(() => {
    model = {
      create: jest.fn().mockResolvedValue({}),
      updateOne: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
      }),
      updateMany: jest.fn().mockReturnValue({
        setOptions: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue({ modifiedCount: 2 }),
      }),
    };
    service = new DeliveryAttemptService(model);
  });

  it('should start an immutable provider delivery attempt without credentials', async () => {
    const attemptId = await service.start({
      tenantId: 'tenant_1',
      messageId: 'message_1',
      conversationId: 'conversation_1',
      channelId: 'channel_1',
      channelType: 'facebook',
    });

    expect(attemptId).toEqual(expect.any(String));
    expect(model.create).toHaveBeenCalledWith({
      tenantId: 'tenant_1',
      messageId: 'message_1',
      conversationId: 'conversation_1',
      channelId: 'channel_1',
      channelType: 'facebook',
      attemptId,
      status: 'started',
      startedAt: expect.any(Date),
    });
  });

  it('should record provider success with compare-and-set semantics', async () => {
    await service.succeed('attempt_1', 'provider_message_1');

    expect(model.updateOne).toHaveBeenCalledWith(
      { attemptId: 'attempt_1', status: 'started' },
      {
        $set: {
          status: 'succeeded',
          completedAt: expect.any(Date),
          externalMessageId: 'provider_message_1',
        },
      },
    );
  });

  it('should mark network timeouts unknown because provider acceptance is ambiguous', async () => {
    await expect(
      service.fail(
        'attempt_1',
        Object.assign(new Error('socket timeout'), { code: 'ETIMEDOUT' }),
      ),
    ).resolves.toBe('unknown');

    expect(model.updateOne).toHaveBeenCalledWith(
      { attemptId: 'attempt_1', status: 'started' },
      {
        $set: expect.objectContaining({
          status: 'unknown',
          errorCode: 'ETIMEDOUT',
          errorSeverity: 'transient',
        }),
      },
    );
  });

  it('should mark a permanent provider rejection failed', async () => {
    await expect(
      service.fail('attempt_1', {
        message: 'invalid recipient',
        response: { status: 400 },
      }),
    ).resolves.toBe('failed');

    expect(model.updateOne).toHaveBeenCalledWith(
      { attemptId: 'attempt_1', status: 'started' },
      {
        $set: expect.objectContaining({
          status: 'failed',
          errorCode: 'UNKNOWN_ERROR',
          errorSeverity: 'permanent',
          httpStatus: 400,
        }),
      },
    );
  });

  it('should reconcile attempts left started after their messages become stale', async () => {
    const reconciledAt = new Date('2026-07-30T12:00:00.000Z');

    await expect(
      service.markStartedUnknownForMessages(
        ['message_1', 'message_2'],
        reconciledAt,
      ),
    ).resolves.toBe(2);

    expect(model.updateMany).toHaveBeenCalledWith(
      {
        messageId: { $in: ['message_1', 'message_2'] },
        status: 'started',
      },
      {
        $set: expect.objectContaining({
          status: 'unknown',
          completedAt: reconciledAt,
          errorCode: 'PROCESS_INTERRUPTED',
        }),
      },
    );
  });
});
