import { NotFoundException } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { createClsMock } from '../test/mocks/cls.mock';

describe('NotificationsService', () => {
  function build(userId: string | null = 'user_1') {
    const model: any = {
      create: jest.fn().mockResolvedValue({}),
      find: jest.fn().mockReturnThis(),
      sort: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([]),
      countDocuments: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(0) }),
      updateOne: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue({ matchedCount: 1 }) }),
      updateMany: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue({ modifiedCount: 3 }) }),
      exists: jest.fn().mockResolvedValue(null),
    };
    const cls = createClsMock({ userId });
    const service = new NotificationsService(model, cls as any);
    return { service, model };
  }

  it('creates a notification with the explicit tenant/user, bypassing CLS', async () => {
    const { service, model } = build();

    await service.create({
      tenantId: 'tenant_1',
      userId: 'other_user',
      type: 'task_reminder',
      title: 'Reminder: Call Acme',
      link: { type: 'Task', id: 'task_1' },
    });

    expect(model.create).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant_1',
        userId: 'other_user',
        type: 'task_reminder',
      }),
    );
  });

  it('swallows a persistence failure instead of throwing', async () => {
    const { service, model } = build();
    model.create.mockRejectedValue(new Error('mongo down'));

    await expect(
      service.create({
        tenantId: 'tenant_1',
        userId: 'user_1',
        type: 'automation',
        title: 'x',
      }),
    ).resolves.toBeUndefined();
  });

  it('scopes listForCaller to the authenticated userId, never a client-supplied one', async () => {
    const { service, model } = build('caller_1');

    await service.listForCaller({ page: 2, limit: 10 });

    expect(model.find).toHaveBeenCalledWith({ userId: 'caller_1' });
  });

  it('rejects markRead for a notification owned by someone else', async () => {
    const { service, model } = build('caller_1');
    model.updateOne.mockReturnValue({
      exec: jest.fn().mockResolvedValue({ matchedCount: 0 }),
    });
    model.exists.mockResolvedValue(null);

    await expect(service.markRead('notif_1')).rejects.toThrow(NotFoundException);
    expect(model.updateOne).toHaveBeenCalledWith(
      { _id: 'notif_1', userId: 'caller_1', readAt: null },
      { $set: { readAt: expect.any(Date) } },
    );
  });

  it('treats marking an already-read notification as idempotent, not an error', async () => {
    const { service, model } = build('caller_1');
    model.updateOne.mockReturnValue({
      exec: jest.fn().mockResolvedValue({ matchedCount: 0 }),
    });
    model.exists.mockResolvedValue({ _id: 'notif_1' });

    await expect(service.markRead('notif_1')).resolves.toBeUndefined();
  });

  it('throws when no authenticated user is in CLS', async () => {
    const { service } = build(null);

    await expect(service.listForCaller({})).rejects.toThrow(NotFoundException);
  });
});
