import {
  mergeCapacityPolicies,
  normalizeCapacityPolicy,
  resolveAfterContactWorkSeconds,
  resolveCapacityWeight,
} from './capacity-policy';

describe('blended capacity policy', () => {
  it('should assigns heavier workload to synchronous voice than digital chat', () => {
    expect(resolveCapacityWeight('voice')).toBe(5);
    expect(resolveCapacityWeight('livechat')).toBe(1);
  });

  it('should supports validated tenant/inbox overrides', () => {
    expect(resolveCapacityWeight('email', { email: 1.5 })).toBe(1.5);
    expect(resolveCapacityWeight('email', { email: 0 })).toBe(1);
    expect(resolveAfterContactWorkSeconds('voice', { voice: 120 })).toBe(120);
  });

  it('should normalizes and merges versioned capacity policies', () => {
    const tenant = normalizeCapacityPolicy({
      version: 1,
      capacityWeights: { Email: 2.5, livechat: 0 },
      afterContactWorkSeconds: { email: 45 },
    });
    const inbox = normalizeCapacityPolicy({
      channelWeights: { email: 1.25 },
      acwSecondsByChannel: { email: 10 },
    });

    const merged = mergeCapacityPolicies(tenant, inbox);

    expect(resolveCapacityWeight('email', merged.capacityWeights)).toBe(1.25);
    expect(resolveCapacityWeight('livechat', merged.capacityWeights)).toBe(1);
    expect(
      resolveAfterContactWorkSeconds('email', merged.afterContactWorkSeconds),
    ).toBe(10);
  });
});
