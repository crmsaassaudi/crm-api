/* eslint-disable @typescript-eslint/require-await */
import { AssignmentQueueMaintenanceService } from './assignment-queue-maintenance.service';

describe('AssignmentQueueMaintenanceService', () => {
  it('should return stale operations to the queue and records telemetry', async () => {
    const exec = jest.fn(async () => ({ modifiedCount: 2 }));
    const queue = { updateMany: jest.fn(() => ({ exec })) };
    const metrics = { incrementCounter: jest.fn() };
    const service = new AssignmentQueueMaintenanceService(
      queue as any,
      metrics as any,
      undefined,
    );

    await expect(service.recoverStaleOperations()).resolves.toBe(2);
    expect(queue.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        status: { $in: ['claiming', 'retrying'] },
      }),
      expect.anything(),
    );
    expect(metrics.incrementCounter).toHaveBeenCalledWith(
      'crm_assignment_queue_stale_operations_recovered_total',
      {},
      2,
    );
  });

  it('should mark overdue items and write an outbox event in one transaction', async () => {
    const item = {
      _id: 'q1',
      tenantId: 't1',
      objectType: 'Ticket',
      entityId: 'e1',
      groupId: 'g1',
      queuedAt: new Date(0),
    };
    const toArray = jest.fn(async () => [item]);
    const endSession = jest.fn(async () => undefined);
    const queue = {
      collection: {
        find: jest.fn(() => ({
          sort: () => ({ limit: () => ({ toArray }) }),
        })),
        updateOne: jest.fn(async () => ({ modifiedCount: 1 })),
      },
      db: {
        startSession: jest.fn(async () => ({
          withTransaction: (work: () => Promise<void>) => work(),
          endSession,
        })),
      },
    };
    const metrics = { incrementCounter: jest.fn() };
    const outbox = {
      collection: { updateOne: jest.fn(async () => ({ upsertedCount: 1 })) },
    };
    const service = new AssignmentQueueMaintenanceService(
      queue as any,
      metrics as any,
      outbox as any,
    );

    await expect(service.escalateOverdueItems()).resolves.toBe(1);
    expect(outbox.collection.updateOne).toHaveBeenCalledWith(
      { tenantId: 't1', eventId: 'queue:q1:sla:1' },
      expect.objectContaining({
        $setOnInsert: expect.objectContaining({
          eventType: 'assignment.queue.escalated',
        }),
      }),
      expect.objectContaining({ upsert: true }),
    );
    expect(metrics.incrementCounter).toHaveBeenCalledWith(
      'crm_assignment_queue_escalations_total',
      { level: '1' },
      1,
    );
    expect(endSession).toHaveBeenCalled();
  });
});
