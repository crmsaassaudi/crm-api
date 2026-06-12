let counter = 0;

export function createUser(overrides: Record<string, any> = {}) {
  counter++;
  const id = overrides.id ?? `user_${counter}`;
  return {
    id,
    keycloakId: `kc_${id}`,
    email: `user${counter}@example.com`,
    firstName: 'Test',
    lastName: 'User',
    tenants: [
      {
        tenantId: 'tenant_1',
        roles: ['MEMBER'],
        joinedAt: new Date('2026-01-01'),
      },
    ],
    platformRole: null,
    provider: 'email',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

export function createAdminUser(overrides: Record<string, any> = {}) {
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
