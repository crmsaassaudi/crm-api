import { AssignmentStartupValidator } from './assignment-startup.validator';
import { AssignableTypeRegistry } from '../core/assignable-type.registry';

describe('AssignmentStartupValidator', () => {
  it('should pass when every advertised object type has an adapter', () => {
    const core = { hasAdapter: jest.fn(() => true) };
    const candidates = { isPresenceProviderConfigured: jest.fn(() => true) };
    const validator = new AssignmentStartupValidator(
      core as any,
      candidates as any,
      new AssignableTypeRegistry(),
    );
    expect(() => validator.onApplicationBootstrap()).not.toThrow();
  });

  it('should fail fast when an advertised object type is not wired', () => {
    const core = {
      hasAdapter: jest.fn((type: string) => type !== 'Conversation'),
    };
    const candidates = { isPresenceProviderConfigured: jest.fn(() => true) };
    const validator = new AssignmentStartupValidator(
      core as any,
      candidates as any,
      new AssignableTypeRegistry(),
    );
    expect(() => validator.onApplicationBootstrap()).toThrow(/Conversation/);
  });
});
