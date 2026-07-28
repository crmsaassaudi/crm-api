/* eslint-disable @typescript-eslint/require-await */
import { RecordAutoAssignmentListener } from './record-auto-assignment.listener';

describe('RecordAutoAssignmentListener', () => {
  const assignment = {
    execute: jest.fn(async () => ({ outcome: 'assigned' })),
  };
  let listener: RecordAutoAssignmentListener;

  beforeEach(() => {
    jest.clearAllMocks();
    listener = new RecordAutoAssignmentListener(assignment as any);
  });

  it('should request assignment for an unowned created record', async () => {
    await listener.handle({
      tenantId: 't1',
      entityType: 'TICKET',
      entityId: 'e1',
      newSnapshot: { priority: 'high' },
    });

    expect(assignment.execute).toHaveBeenCalledWith(
      'record-created:Ticket:e1',
      expect.objectContaining({
        tenantId: 't1',
        objectType: 'Ticket',
        entityId: 'e1',
        attributes: { priority: 'high' },
      }),
    );
  });

  it('should not overwrite an owner supplied during create', async () => {
    await listener.handle({
      tenantId: 't1',
      entityType: 'CONTACT',
      entityId: 'e1',
      newSnapshot: { ownerId: 'u1' },
    });
    expect(assignment.execute).not.toHaveBeenCalled();
  });

  it('should ignore legacy created events without a snapshot', async () => {
    await listener.handle({
      tenantId: 't1',
      entityType: 'CONTACT',
      entityId: 'e1',
    });
    expect(assignment.execute).not.toHaveBeenCalled();
  });
});
