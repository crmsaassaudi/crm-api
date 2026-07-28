/* eslint-disable @typescript-eslint/require-await */
import { AssignmentCommandService } from './assignment-command.service';

describe('AssignmentCommandService', () => {
  const updateOne = jest.fn(async () => ({ modifiedCount: 1 }));
  const commands = {
    findOne: jest.fn(() => ({
      lean: () => ({ exec: jest.fn(async () => null) }),
    })),
    create: jest.fn(async (value: any) => ({ _id: 'cmd1', ...value })),
    updateOne,
    db: {
      startSession: jest.fn(async () => ({
        withTransaction: async (work: () => Promise<void>) => work(),
        endSession: jest.fn(async () => undefined),
      })),
    },
  };
  const outbox = { updateOne: jest.fn(async () => ({ upsertedCount: 1 })) };
  const core = {
    assign: jest.fn(async () => ({
      outcome: 'assigned',
      assigneeId: 'u1',
    })),
  };
  const request = {
    tenantId: 't1',
    objectType: 'Ticket' as const,
    entityId: 'e1',
  };

  beforeEach(() => jest.clearAllMocks());

  it('should persist a command envelope and passes commandId to the core', async () => {
    const service = new AssignmentCommandService(
      commands as any,
      outbox as any,
      core as any,
      {} as any,
    );
    await service.execute('created:ticket:e1', request);

    expect(commands.create).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: 'created:ticket:e1',
        status: 'processing',
      }),
    );
    expect(core.assign).toHaveBeenCalledWith(
      expect.objectContaining({ commandId: 'cmd1' }),
    );
    expect(updateOne).toHaveBeenCalledWith(
      { _id: 'cmd1', status: 'processing' },
      expect.objectContaining({
        $set: expect.objectContaining({ status: 'completed' }),
      }),
      expect.objectContaining({ session: expect.any(Object) }),
    );
  });

  it('should return a previously completed decision without executing again', async () => {
    commands.findOne.mockReturnValueOnce({
      lean: () => ({
        exec: jest.fn(async () => ({
          status: 'completed',
          decision: { outcome: 'assigned', assigneeId: 'u1' },
        })),
      }),
    } as any);
    const service = new AssignmentCommandService(
      commands as any,
      outbox as any,
      core as any,
      {} as any,
    );
    const result = await service.execute('created:ticket:e1', request);
    expect(result.assigneeId).toBe('u1');
    expect(core.assign).not.toHaveBeenCalled();
  });
});
