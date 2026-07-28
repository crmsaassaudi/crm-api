import { AssignableTypeRegistry } from './assignable-type.registry';

describe('AssignableTypeRegistry', () => {
  it('should expose immutable capabilities for every built-in type', () => {
    const registry = new AssignableTypeRegistry();
    expect(registry.list()).toHaveLength(7);
    expect(
      registry.list().find((entry) => entry.objectType === 'Conversation'),
    ).toEqual(
      expect.objectContaining({
        preferredAssignee: true,
        durableQueue: false,
      }),
    );
  });

  it('should reject duplicate registrations', () => {
    const registry = new AssignableTypeRegistry();
    expect(() =>
      registry.register({
        objectType: 'Ticket',
        preferredAssignee: false,
        onlineHardGate: true,
        durableQueue: true,
      }),
    ).toThrow(/already registered/);
  });
});
