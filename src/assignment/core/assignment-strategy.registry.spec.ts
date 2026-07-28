import { AssignmentStrategyRegistry } from './assignment-strategy.registry';

describe('AssignmentStrategyRegistry', () => {
  it('should register executable built-in strategy metadata', () => {
    const registry = new AssignmentStrategyRegistry();
    expect(registry.get('round-robin')).toEqual(
      expect.objectContaining({
        reservationMode: 'first-eligible',
        rotateCandidates: true,
      }),
    );
    expect(registry.get('least-busy')?.enforceCapacity).toBe(false);
  });

  it('should reject duplicate strategy plugins', () => {
    const registry = new AssignmentStrategyRegistry();
    expect(() =>
      registry.register({
        name: 'round-robin',
        reservationMode: 'first-eligible',
        rotateCandidates: true,
        enforceCapacity: true,
        loadOrdered: false,
      }),
    ).toThrow(/already registered/);
  });
});
