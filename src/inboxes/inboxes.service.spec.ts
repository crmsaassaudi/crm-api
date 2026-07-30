import { ConflictException, NotFoundException } from '@nestjs/common';
import { InboxesService } from './inboxes.service';

describe('InboxesService', () => {
  let model: any;
  let service: InboxesService;

  beforeEach(() => {
    model = {
      find: jest.fn(),
      findOne: jest.fn(),
      findOneAndUpdate: jest.fn(),
      create: jest.fn(),
    };
    service = new InboxesService(
      model,
      {} as any,
      {
        get: jest.fn().mockReturnValue('tenant_1'),
      } as any,
    );
  });

  it('should always scopes list queries to the current tenant', async () => {
    const exec = jest.fn().mockResolvedValue([]);
    model.find.mockReturnValue({
      sort: jest
        .fn()
        .mockReturnValue({ lean: jest.fn().mockReturnValue({ exec }) }),
    });

    await service.list();

    expect(model.find).toHaveBeenCalledWith({
      tenantId: 'tenant_1',
      status: 'active',
    });
  });

  it('should creates inboxes inside the current tenant', async () => {
    model.create.mockResolvedValue({ _id: 'inbox_1' });

    await service.create({ name: 'Support', key: 'SUPPORT' } as any);

    expect(model.create).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant_1',
        name: 'Support',
        key: 'support',
      }),
    );
  });

  it('should maps a tenant-local duplicate key to conflict', async () => {
    model.create.mockRejectedValue({ code: 11000 });

    await expect(
      service.create({ name: 'Support', key: 'support' } as any),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('should does not expose an inbox from another tenant by id', async () => {
    model.findOne.mockReturnValue({
      lean: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue(null),
      }),
    });

    await expect(service.get('inbox_other')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(model.findOne).toHaveBeenCalledWith({
      _id: 'inbox_other',
      tenantId: 'tenant_1',
    });
  });

  it('should attaches only a tenant-local channel to an active tenant-local inbox', async () => {
    model.findOne.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue({ _id: 'inbox_1' }),
        }),
      }),
    });
    const channelModel = {
      findOneAndUpdate: jest.fn().mockReturnValue({
        lean: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue({ _id: 'channel_1' }),
        }),
      }),
    };
    service = new InboxesService(
      model,
      channelModel as any,
      {
        get: jest.fn().mockReturnValue('tenant_1'),
      } as any,
    );

    await expect(
      service.attachChannel('inbox_1', 'channel_1'),
    ).resolves.toEqual({ inboxId: 'inbox_1', channelId: 'channel_1' });
    expect(channelModel.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'channel_1', tenantId: 'tenant_1' },
      { $set: { inboxId: 'inbox_1' } },
      { new: true },
    );
  });
});
