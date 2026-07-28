import { AutomationOutboxService } from './automation-outbox.service';
import { AutomationEventPayload } from './automation-event.payload';

describe('AutomationOutboxService', () => {
  const payload: AutomationEventPayload = {
    tenantId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
    event: 'record_created',
    object: 'Contact',
    recordId: 'contact-1',
    data: { id: 'contact-1' },
    triggerUserId: 'actor-1',
  };

  const build = (publishError?: Error) => {
    const updateQuery = {
      setOptions: jest.fn().mockResolvedValue({ acknowledged: true }),
    };
    const model = {
      create: jest.fn().mockResolvedValue({}),
      insertMany: jest.fn().mockResolvedValue([]),
      findOneAndUpdate: jest.fn((filter: { eventId: string }) => {
        const claimed = {
          _id: 'outbox-1',
          eventId: filter.eventId,
          eventType: 'record_created.Contact',
          retryCount: 0,
          payload: { ...payload, eventId: filter.eventId },
        };
        const chain: any = {
          setOptions: jest.fn(() => chain),
          lean: jest.fn(() => chain),
          exec: jest.fn().mockResolvedValue(claimed),
        };
        return chain;
      }),
      updateOne: jest.fn(() => updateQuery),
    };
    const triggerProducer = {
      enqueue: publishError
        ? jest.fn().mockRejectedValue(publishError)
        : jest.fn().mockResolvedValue(undefined),
    };
    const commit = jest.fn();
    const transactions = {
      runInTransaction: jest.fn(async (work) => {
        const result = await work({ id: 'session' });
        commit();
        return result;
      }),
    };
    const service = new AutomationOutboxService(
      model as any,
      triggerProducer as any,
      transactions as any,
    );
    return { service, model, triggerProducer, transactions, commit };
  };

  it('should persist before publishing and propagate one stable eventId', async () => {
    const { service, model, triggerProducer } = build();

    const eventId = await service.capture(payload);

    expect(model.create).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          tenantId: payload.tenantId,
          eventId,
          status: 'pending',
          payload: expect.objectContaining({ eventId }),
        }),
      ],
      { session: undefined },
    );
    expect(model.create.mock.invocationCallOrder[0]).toBeLessThan(
      triggerProducer.enqueue.mock.invocationCallOrder[0],
    );
    expect(triggerProducer.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ eventId, triggerUserId: 'actor-1' }),
    );
  });

  it('should persist in the same session and publish only after commit', async () => {
    const { service, model, triggerProducer, commit } = build();

    await service.runWithEvent(
      () => Promise.resolve({ id: 'contact-1' }),
      () => payload,
    );

    expect(model.create).toHaveBeenCalledWith(expect.any(Array), {
      session: { id: 'session' },
    });
    expect(commit.mock.invocationCallOrder[0]).toBeLessThan(
      triggerProducer.enqueue.mock.invocationCallOrder[0],
    );
  });

  it('should not publish when transactional outbox persistence fails', async () => {
    const { service, model, triggerProducer, commit } = build();
    model.create.mockRejectedValue(new Error('mongo unavailable'));

    await expect(
      service.runWithEvent(
        () => Promise.resolve({ id: 'contact-1' }),
        () => payload,
      ),
    ).rejects.toThrow('mongo unavailable');

    expect(commit).not.toHaveBeenCalled();
    expect(triggerProducer.enqueue).not.toHaveBeenCalled();
  });

  it('should persist a batch of events in one transaction', async () => {
    const { service, model, triggerProducer, commit } = build();
    const second = {
      ...payload,
      event: 'field_updated' as const,
      object: 'Deal' as const,
      recordId: 'deal-2',
    };

    await service.runWithEvents(() =>
      Promise.resolve({ result: true, payloads: [payload, second] }),
    );

    expect(model.insertMany).toHaveBeenCalledWith(
      [
        expect.objectContaining({ aggregateId: 'contact-1' }),
        expect.objectContaining({ aggregateId: 'deal-2' }),
      ],
      { session: { id: 'session' }, ordered: true },
    );
    expect(commit).toHaveBeenCalledTimes(1);
    expect(triggerProducer.enqueue).toHaveBeenCalledTimes(2);
    expect(commit.mock.invocationCallOrder[0]).toBeLessThan(
      triggerProducer.enqueue.mock.invocationCallOrder[0],
    );
  });

  it('should keep the durable row pending when Redis publication fails', async () => {
    const { service, model } = build(new Error('redis unavailable'));

    await expect(service.capture(payload)).resolves.toEqual(expect.any(String));

    expect(model.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: 'outbox-1', status: 'publishing' }),
      expect.objectContaining({
        $set: expect.objectContaining({
          status: 'pending',
          lastError: 'redis unavailable',
        }),
        $inc: { retryCount: 1 },
      }),
    );
  });

  it('should fail the caller when the durable Mongo write itself fails', async () => {
    const { service, model, triggerProducer } = build();
    model.create.mockRejectedValue(new Error('mongo unavailable'));

    await expect(service.capture(payload)).rejects.toThrow('mongo unavailable');
    expect(triggerProducer.enqueue).not.toHaveBeenCalled();
  });
});
