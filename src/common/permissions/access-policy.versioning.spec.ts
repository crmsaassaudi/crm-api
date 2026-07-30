import { AccessPolicyService } from './access-policy.service';

describe('AccessPolicyService versioning and simulation', () => {
  const audit = { record: jest.fn() };

  it('should simulate a candidate without writing it', () => {
    const model = { create: jest.fn() };
    const service = new AccessPolicyService(model as any, audit as any);

    expect(
      service.simulate(
        {
          name: 'closed deal deny',
          resource: 'deals',
          action: 'edit',
          effect: 'deny',
          conditions: [
            {
              attribute: 'resource.stage',
              operator: 'eq',
              value: 'closed',
            },
          ],
        },
        { resource: { stage: 'closed' } },
      ),
    ).toEqual({ applies: true, effect: 'deny' });
    expect(model.create).not.toHaveBeenCalled();
  });

  it('should publish rollback as a new immutable revision', async () => {
    const save = jest.fn();
    const policy: any = {
      _id: 'p1',
      name: 'current',
      resource: 'deals',
      action: 'edit',
      effect: 'allow',
      conditions: [],
      active: true,
      priority: 100,
      revision: 2,
      versions: [
        {
          revision: 1,
          snapshot: {
            name: 'original deny',
            description: '',
            resource: 'deals',
            action: 'edit',
            effect: 'deny',
            conditions: [],
            active: true,
            priority: 100,
          },
        },
      ],
      save,
    };
    save.mockImplementation(() => Promise.resolve(policy));
    const model = {
      findOne: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue(policy),
      }),
    };
    const service = new AccessPolicyService(model as any, audit as any);

    await service.rollback('p1', 't1', 1);

    expect(policy.effect).toBe('deny');
    expect(policy.revision).toBe(3);
    expect(policy.versions).toHaveLength(2);
    expect(policy.versions[1]).toEqual(
      expect.objectContaining({ revision: 3, sourceRevision: 1 }),
    );
  });
});
