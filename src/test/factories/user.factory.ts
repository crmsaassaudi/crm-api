import { User } from '../../users/domain/user';

let counter = 0;

/**
 * Factory for creating test User objects.
 *
 * Uses Partial<User> for type-safety:
 * If production User adds a required field, TypeScript
 * will flag this factory at compile time.
 */
export function createUser(overrides: Partial<User> = {}): User {
  counter++;
  const id = overrides.id ?? `user_${counter}`;
  return {
    id,
    keycloakId: `kc_${id}`,
    email: `user${counter}@example.com`,
    firstName: 'Test',
    lastName: 'User',
    provider: 'email',
    tenants: [
      {
        tenantId: 'tenant_1',
        roles: ['MEMBER'],
        joinedAt: new Date('2026-01-01'),
      },
    ],
    platformRole: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  } as User;
}

export function createAdminUser(overrides: Partial<User> = {}): User {
  return createUser({
    tenants: [
      {
        tenantId: 'tenant_1',
        roles: ['ADMIN'],
        joinedAt: new Date('2026-01-01'),
      },
    ],
    ...overrides,
  });
}
