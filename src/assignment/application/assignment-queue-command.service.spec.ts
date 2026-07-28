import { ConflictException } from '@nestjs/common';
/* eslint-disable @typescript-eslint/require-await */
import { AssignmentQueueCommandService } from './assignment-queue-command.service';

const objectId = '507f1f77bcf86cd799439011';
const groupId = '507f1f77bcf86cd799439012';
const userId = '507f1f77bcf86cd799439013';

describe('AssignmentQueueCommandService', () => {
  const item = {
    _id: objectId,
    tenantId: objectId,
    objectType: 'Ticket',
    entityId: '507f1f77bcf86cd799439014',
    groupId,
    status: 'claiming',
    operationId: 'op1',
  };
  const exec = jest.fn(async () => item);
  const queue = {
    findOneAndUpdate: jest.fn(() => ({
      lean: () => ({ exec }),
    })),
    exists: jest.fn(async () => ({ _id: objectId })),
    updateOne: jest.fn(() => ({ exec: jest.fn(async () => undefined) })),
  };
  const connection = {
    collection: jest.fn(() => ({
      findOne: jest.fn(async () => ({ _id: objectId })),
    })),
  };
  const core = {
    assign: jest.fn(async () => ({
      outcome: 'assigned',
      assigneeId: userId,
    })),
  };
  const cls = {
    get: jest.fn((key: string) => {
      if (key === 'tenantId') return objectId;
      if (key === 'userId') return userId;
      return undefined;
    }),
  };

  beforeEach(() => jest.clearAllMocks());

  it('should claim with CAS and route through the assignment core', async () => {
    const service = new AssignmentQueueCommandService(
      queue as any,
      connection as any,
      core as any,
      cls as any,
    );
    const result = await service.claim(objectId);

    expect(queue.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'queued' }),
      expect.anything(),
      { new: true },
    );
    expect(core.assign).toHaveBeenCalledWith(
      expect.objectContaining({
        objectType: 'Ticket',
        manualAssigneeId: userId,
        source: 'manual',
      }),
    );
    expect(result.outcome).toBe('assigned');
  });

  it('should reject a concurrent command that lost the queue CAS', async () => {
    exec.mockResolvedValueOnce(null as any);
    const service = new AssignmentQueueCommandService(
      queue as any,
      connection as any,
      core as any,
      cls as any,
    );
    await expect(service.retry(objectId)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(core.assign).not.toHaveBeenCalled();
  });
});
