import { ContactStageTransitionListener } from './contact-stage-transition.listener';

describe('ContactStageTransitionListener', () => {
  it('should upsert by stable event id so retries are idempotent', async () => {
    const exec = jest.fn().mockResolvedValue({});
    const setOptions = jest.fn(() => ({ exec }));
    const updateOne = jest.fn(() => ({ setOptions }));
    const listener = new ContactStageTransitionListener({
      updateOne,
    } as any);

    await listener.record({
      eventId: 'event-1',
      tenantId: '60d0fe4f5311236168a109cc',
      contactId: '60d0fe4f5311236168a109ca',
      fromStage: 'lead',
      toStage: 'customer',
      occurredAt: new Date('2026-07-30T00:00:00Z'),
      changedById: '60d0fe4f5311236168a109cb',
      direction: 'forward',
      skippedStages: ['qualified'],
    });

    expect(updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 'event-1' }),
      expect.objectContaining({
        $setOnInsert: expect.objectContaining({
          toStage: 'customer',
          skippedStages: ['qualified'],
        }),
      }),
      { upsert: true },
    );
    expect(exec).toHaveBeenCalled();
  });
});
