/* eslint-disable @typescript-eslint/require-await */
import { RecordWorkloadListener } from './record-workload.listener';

describe('RecordWorkloadListener', () => {
  const reservation = {
    adjustIfTracked: jest.fn(async () => true),
  };
  const connection = {
    collection: jest.fn(() => ({
      deleteOne: jest.fn(async () => ({ deletedCount: 1 })),
    })),
  };
  let listener: RecordWorkloadListener;

  beforeEach(() => {
    jest.clearAllMocks();
    listener = new RecordWorkloadListener(
      reservation as any,
      connection as any,
    );
  });

  it('should move one active workload unit when owner changes', async () => {
    await listener.handle({
      tenantId: 't1',
      entityType: 'TICKET',
      oldSnapshot: { ownerId: 'u1' },
      newSnapshot: { ownerId: 'u2' },
    });

    expect(reservation.adjustIfTracked).toHaveBeenNthCalledWith(
      1,
      't1:Ticket',
      'u1',
      -1,
    );
    expect(reservation.adjustIfTracked).toHaveBeenNthCalledWith(
      2,
      't1:Ticket',
      'u2',
      1,
    );
  });

  it('should release workload when a ticket is closed', async () => {
    await listener.handle({
      tenantId: 't1',
      entityType: 'TICKET',
      oldSnapshot: { ownerId: 'u1', closedAt: null },
      newSnapshot: { ownerId: 'u1', closedAt: new Date().toISOString() },
    });

    expect(reservation.adjustIfTracked).toHaveBeenCalledWith(
      't1:Ticket',
      'u1',
      -1,
    );
  });

  it('should add workload when a task is reopened', async () => {
    await listener.handle({
      tenantId: 't1',
      entityType: 'TASK',
      oldSnapshot: { ownerId: 'u1', completedAt: '2026-01-01' },
      newSnapshot: { ownerId: 'u1', completedAt: null },
    });

    expect(reservation.adjustIfTracked).toHaveBeenCalledWith(
      't1:Task',
      'u1',
      1,
    );
  });

  it('should ignore legacy events without snapshots', async () => {
    await listener.handle({
      tenantId: 't1',
      entityType: 'CONTACT',
    });
    expect(reservation.adjustIfTracked).not.toHaveBeenCalled();
  });
});
