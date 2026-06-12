import { Tenant } from '../../tenants/domain/tenant';

let counter = 0;

/**
 * Factory for creating test Tenant objects.
 *
 * Uses Partial<Tenant> for type-safety:
 * If production Tenant adds a required field, TypeScript
 * will flag this factory at compile time.
 */
export function createTenant(overrides: Partial<Tenant> = {}): Tenant {
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
  } as Tenant;
}
