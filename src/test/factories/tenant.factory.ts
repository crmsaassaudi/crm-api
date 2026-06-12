let counter = 0;

export function createTenant(overrides: Record<string, any> = {}) {
  counter++;
  const id = overrides.id ?? `tenant_${counter}`;
  return {
    id,
    name: `Test Company ${counter}`,
    alias: `test-company-${counter}`,
    ownerId: 'owner_1',
    keycloakOrgId: `kc_org_${counter}`,
    availablePermissions: [
      'contacts:view',
      'contacts:create',
      'contacts:edit',
      'contacts:delete',
      'tickets:view',
      'tickets:create',
      'tickets:edit',
      'tickets:delete',
    ],
    disabledCorePermissions: [],
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}
