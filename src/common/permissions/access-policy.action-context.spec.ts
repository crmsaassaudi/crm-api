import { ServiceUnavailableException } from '@nestjs/common';
import { AccessPolicyService } from './access-policy.service';

describe('AccessPolicyService action-context evaluation', () => {
  const build = (policies: any[] | Error) => {
    const normalizedPolicies =
      policies instanceof Error
        ? policies
        : policies.map((policy) => ({
            resource: '*',
            action: '*',
            ...policy,
          }));
    const exec =
      normalizedPolicies instanceof Error
        ? jest.fn().mockRejectedValue(normalizedPolicies)
        : jest.fn().mockResolvedValue(normalizedPolicies);
    const model = {
      find: jest.fn().mockReturnValue({
        sort: jest.fn().mockReturnValue({
          lean: jest.fn().mockReturnValue({ exec }),
        }),
      }),
    };
    return {
      service: new AccessPolicyService(
        model as any,
        { record: jest.fn() } as any,
      ),
      model,
    };
  };

  it('should apply a subject-only deny to collection actions', async () => {
    const { service } = build([
      {
        effect: 'deny',
        conditions: [
          {
            attribute: 'subject.principalType',
            operator: 'eq',
            value: 'automation',
          },
        ],
      },
    ]);

    await expect(
      service.evaluateActionContext('t1', 'contacts', 'export', {
        subject: { principalType: 'automation' },
        env: { now: new Date() },
      }),
    ).resolves.toBe('deny');
  });

  it('should apply an environment/time deny to collection actions', async () => {
    const now = new Date('2026-07-28T20:00:00.000Z');
    const { service } = build([
      {
        effect: 'deny',
        conditions: [
          {
            attribute: 'env.now',
            operator: 'gte',
            value: '2026-07-28T18:00:00.000Z',
          },
        ],
      },
    ]);

    await expect(
      service.evaluateActionContext('t1', 'contacts', 'export', {
        subject: { id: 'u1' },
        env: { now },
      }),
    ).resolves.toBe('deny');
  });

  it('should defer resource-dependent policies until record/query evaluation', async () => {
    const { service } = build([
      {
        effect: 'deny',
        conditions: [
          {
            attribute: 'resource.region',
            operator: 'ne',
            valueAttribute: 'subject.region',
          },
        ],
      },
    ]);

    await expect(
      service.evaluateActionContext('t1', 'contacts', 'view', {
        subject: { region: 'SA' },
        env: { now: new Date() },
      }),
    ).resolves.toBeNull();
  });

  it('should fail closed when the policy store is unavailable', async () => {
    const { service } = build(new Error('mongo unavailable'));
    await expect(
      service.evaluateActionContext('t1', 'contacts', 'view', {
        subject: { id: 'u1' },
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
