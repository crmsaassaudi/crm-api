import { ClsServiceManager } from 'nestjs-cls';
import { DealFollowUpService } from './deal-follow-up.service';
import { TasksService } from '../tasks/tasks.service';

describe('DealFollowUpService', () => {
  const dealId = 'deal-1';
  const tenantId = 'tenant-1';

  function build(overrides: {
    tasksCreate?: jest.Mock;
    findResult?: any[];
  }) {
    const dealDoc = overrides.findResult ?? [];
    const query: any = {
      setOptions: jest.fn().mockReturnThis(),
      sort: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue(dealDoc),
    };
    const dealModel: any = {
      find: jest.fn().mockReturnValue(query),
      updateOne: jest.fn().mockReturnValue({
        setOptions: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
      }),
    };
    const redis: any = { publish: jest.fn().mockResolvedValue(1) };
    const tasksService = {
      create: overrides.tasksCreate ?? jest.fn().mockResolvedValue({}),
    } as unknown as TasksService;
    const cls = ClsServiceManager.getClsService();

    const service = new DealFollowUpService(
      dealModel,
      redis,
      cls,
      tasksService,
    );
    return { service, dealModel, redis, tasksService };
  }

  it('creates a Task owned by the deal owner when a follow-up comes due', async () => {
    const create = jest.fn().mockResolvedValue({});
    const { service } = build({
      tasksCreate: create,
      findResult: [
        {
          _id: dealId,
          tenantId,
          ownerId: 'owner-1',
          orgUnitId: 'org-1',
          title: 'Acme renewal',
          nextFollowUpAt: new Date(Date.now() - 60_000),
        },
      ],
    });

    const result = await service.dispatchDueFollowUps();

    expect(result.sent).toBe(1);
    expect(create).toHaveBeenCalledTimes(1);
    const payload = create.mock.calls[0][0];
    expect(payload.ownerId).toBe('owner-1');
    expect(payload.orgUnitId).toBe('org-1');
    expect(payload.relatedTo).toEqual({
      type: 'Deal',
      id: dealId,
      name: 'Acme renewal',
    });
  });

  it('skips Task creation for an unowned deal but still counts as sent', async () => {
    const create = jest.fn();
    const { service } = build({
      tasksCreate: create,
      findResult: [
        {
          _id: dealId,
          tenantId,
          ownerId: null,
          title: 'Unowned deal',
          nextFollowUpAt: new Date(Date.now() - 60_000),
        },
      ],
    });

    const result = await service.dispatchDueFollowUps();

    expect(result.sent).toBe(1);
    expect(create).not.toHaveBeenCalled();
  });
});
