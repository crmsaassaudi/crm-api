/* eslint-disable @typescript-eslint/require-await */
import { AssignmentPolicyVersionService } from './assignment-policy-version.service';

describe('AssignmentPolicyVersionService', () => {
  it('should create a deterministic content-addressed immutable snapshot', async () => {
    const updateOne = jest.fn(async () => ({ upsertedCount: 1 }));
    const service = new AssignmentPolicyVersionService({ updateOne } as any);
    const config = { autoAssignEnabled: true, defaultStrategy: 'round-robin' };
    const rules = [{ id: 'r1', name: 'Priority', priority: 0 }];

    const first = await service.capture(
      't1',
      'Ticket',
      config as any,
      rules as any,
    );
    const second = await service.capture(
      't1',
      'Ticket',
      { defaultStrategy: 'round-robin', autoAssignEnabled: true } as any,
      rules as any,
    );

    expect(second).toBe(first);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(updateOne).toHaveBeenCalledWith(
      { tenantId: 't1', objectType: 'Ticket', versionId: first },
      expect.objectContaining({
        $setOnInsert: expect.objectContaining({ config, rules }),
      }),
      { upsert: true },
    );
  });
});
