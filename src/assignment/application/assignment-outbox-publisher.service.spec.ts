/* eslint-disable @typescript-eslint/require-await */
import { AssignmentOutboxPublisherService } from './assignment-outbox-publisher.service';

describe('AssignmentOutboxPublisherService', () => {
  it('should claim and publish pending events', async () => {
    const candidate = {
      _id: 'o1',
      eventId: 'cmd1:decided',
      eventType: 'assignment.decided',
      payload: { commandId: 'cmd1' },
      status: 'pending',
      retryCount: 0,
    };
    const findExec = jest.fn(async () => [candidate]);
    const claimExec = jest.fn(async () => ({
      ...candidate,
      status: 'publishing',
    }));
    const updateQuery = { setOptions: jest.fn(async () => undefined) };
    const outbox = {
      find: jest.fn(() => ({
        sort: () => ({
          limit: () => ({
            lean: () => ({
              setOptions: () => ({ exec: findExec }),
            }),
          }),
        }),
      })),
      findOneAndUpdate: jest.fn(() => ({
        setOptions: () => ({ lean: () => ({ exec: claimExec }) }),
      })),
      updateOne: jest.fn(() => updateQuery),
    };
    const events = { emitAsync: jest.fn(async () => [undefined]) };
    const metrics = { incrementCounter: jest.fn() };
    const service = new AssignmentOutboxPublisherService(
      outbox as any,
      events as any,
      metrics as any,
    );

    await expect(service.publishPending()).resolves.toBe(1);
    expect(events.emitAsync).toHaveBeenCalledWith(
      'assignment.decided',
      candidate.payload,
    );
    expect(metrics.incrementCounter).toHaveBeenCalledWith(
      'crm_assignment_outbox_published_total',
      { eventType: 'assignment.decided' },
    );
  });
});
