/* eslint-disable @typescript-eslint/require-await */
import { AssignmentAuditArchiveService } from './assignment-audit-archive.service';

describe('AssignmentAuditArchiveService', () => {
  it('should copy due rows and checkpoint them in one transaction', async () => {
    const row = {
      _id: 'a1',
      tenantId: 't1',
      objectType: 'Ticket',
      entityId: 'e1',
      createdAt: new Date(0),
    };
    const endSession = jest.fn(async () => undefined);
    const hot = {
      collection: {
        find: jest.fn(() => ({
          sort: () => ({ limit: () => ({ toArray: async () => [row] }) }),
        })),
        updateMany: jest.fn(async () => ({ modifiedCount: 1 })),
      },
      db: {
        startSession: jest.fn(async () => ({
          withTransaction: (work: () => Promise<void>) => work(),
          endSession,
        })),
      },
    };
    const archive = {
      collection: { bulkWrite: jest.fn(async () => ({ upsertedCount: 1 })) },
    };
    const metrics = { incrementCounter: jest.fn() };
    const service = new AssignmentAuditArchiveService(
      hot as any,
      archive as any,
      metrics as any,
    );

    await expect(service.archiveDue()).resolves.toBe(1);
    expect(archive.collection.bulkWrite).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          updateOne: expect.objectContaining({
            filter: { tenantId: 't1', sourceAuditId: 'a1' },
            upsert: true,
          }),
        }),
      ],
      expect.objectContaining({ ordered: false }),
    );
    expect(hot.collection.updateMany).toHaveBeenCalled();
    expect(metrics.incrementCounter).toHaveBeenCalledWith(
      'crm_assignment_audit_archived_total',
      {},
      1,
    );
    expect(endSession).toHaveBeenCalled();
  });
});
