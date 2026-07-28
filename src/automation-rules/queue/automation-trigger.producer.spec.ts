import { AutomationTriggerProducer } from './automation-trigger.producer';

describe('AutomationTriggerProducer', () => {
  it('should preserve triggerUserId across the queue boundary', async () => {
    const queue = { add: jest.fn().mockResolvedValue(undefined) };
    const producer = new AutomationTriggerProducer(queue as any);

    await producer.enqueue({
      tenantId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      event: 'record_created',
      object: 'Contact',
      recordId: 'contact-1',
      data: { ownerId: 'owner-1' },
      triggerUserId: 'actor-1',
    });

    expect(queue.add).toHaveBeenCalledWith(
      'record_created.Contact',
      expect.objectContaining({ triggerUserId: 'actor-1' }),
      expect.any(Object),
    );
  });

  it('should use the outbox eventId as the BullMQ deduplication key', async () => {
    const queue = { add: jest.fn().mockResolvedValue(undefined) };
    const producer = new AutomationTriggerProducer(queue as any);

    await producer.enqueue({
      eventId: '01K123EVENT',
      tenantId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      event: 'field_updated',
      object: 'Deal',
      recordId: 'deal-1',
      data: {},
    });

    expect(queue.add).toHaveBeenCalledWith(
      'field_updated.Deal',
      expect.objectContaining({ eventId: '01K123EVENT' }),
      expect.objectContaining({
        jobId: 'automation-event-01K123EVENT',
      }),
    );
  });
});
