/**
 * SYSTEM ROLE TEMPLATES — the single source of truth for the roles every tenant
 * gets out of the box.
 *
 * Model: "immutable system roles + clone-to-customize", the same shape used by
 * Salesforce standard profiles, Zendesk predefined roles, Google Workspace
 * prebuilt admin roles and Entra built-in roles:
 *
 *   1. Definitions live centrally, HERE — not as free-form per-tenant rows.
 *   2. They are materialised into `custom_roles` per tenant on tenant creation
 *      (`isSystem: true` + `systemKey` + `templateVersion`) so they have real
 *      _ids. That keeps `roleIds` referential integrity intact and means the
 *      authorization engine needs no special-casing at all.
 *   3. They are IMMUTABLE — the API rejects update/delete on them. Admins who
 *      want a variation clone the role (POST /roles/:id/clone).
 *   4. Immutability is what makes central upgrades safe: because no tenant can
 *      have edited them, bumping `version` here lets the seeder re-sync the
 *      permission list of existing tenants without destroying anyone's work.
 *
 * Administrator is deliberately NOT a template. Tenant admins are granted via
 * the `ADMIN` tenant-role flag, which short-circuits to the whole tenant
 * ceiling in permission.engine.ts. A snapshot of permission keys would silently
 * miss every key added in a later release; a flag never goes stale. The Roles
 * page surfaces it as a read-only pseudo-role so it is still visible.
 *
 * IMPORTANT: only reference CORE_PERMISSIONS keys in a template unless you also
 * set `requiresFeature`. A key outside a tenant's ceiling is dropped silently
 * by the engine, which looks like a bug to the admin who granted it.
 */

export interface SystemRoleTemplate {
  /** Stable identity across tenants and releases. Never change or reuse. */
  systemKey: string;
  name: string;
  description: string;
  color: string;
  /**
   * Bump when `permissions` / `name` / `description` change. The seeder
   * re-syncs materialised rows whose stored templateVersion is lower.
   */
  version: number;
  /** Explicit permission keys. Ignored when `dynamic` is set. */
  permissions: string[];
  /**
   * Resolve permissions from the tenant's live ceiling instead of a fixed list.
   * `all_view` → every `*:view` key the tenant actually has.
   */
  dynamic?: 'all_view';
  /**
   * Only materialise this role when the tenant's ceiling contains this key
   * (feature/plan gating — mirrors Salesforce only showing licensed profiles).
   */
  requiresFeature?: string;
}

export const SYSTEM_ROLE_TEMPLATES: SystemRoleTemplate[] = [
  {
    systemKey: 'sys.manager',
    name: 'Manager',
    description:
      'Full operational access across CRM modules, including delete and assignment.',
    color: '#8b5cf6',
    version: 1,
    permissions: [
      'leads:view',
      'leads:create',
      'leads:edit',
      'leads:delete',
      'leads:assign',
      'contacts:view',
      'contacts:create',
      'contacts:edit',
      'contacts:delete',
      'accounts:view',
      'accounts:create',
      'accounts:edit',
      'accounts:delete',
      'deals:view',
      'deals:create',
      'deals:edit',
      'deals:delete',
      'deals:move_stage',
      'tickets:view',
      'tickets:create',
      'tickets:edit',
      'tickets:delete',
      'tickets:resolve',
      'tasks:view',
      'tasks:create',
      'tasks:edit',
      'tasks:delete',
      'reports:view',
      'reports:contact:view',
      'reports:deal:view',
      'reports:ticket:view',
      'reports:agent:view',
      'users:view',
      'groups:view',
      'tags:view',
      'tags:create',
      'tags:edit',
      'files:view',
      'files:create',
      'files:edit',
      'omni_channel:view',
      'omni_reports:view',
    ],
  },
  {
    systemKey: 'sys.sales_rep',
    name: 'Sales Rep',
    description: 'Work leads, contacts, accounts and deals day to day.',
    color: '#22c55e',
    version: 1,
    permissions: [
      'leads:view',
      'leads:create',
      'leads:edit',
      'contacts:view',
      'contacts:create',
      'contacts:edit',
      'accounts:view',
      'accounts:create',
      'accounts:edit',
      'deals:view',
      'deals:create',
      'deals:edit',
      'deals:move_stage',
      'tasks:view',
      'tasks:create',
      'tasks:edit',
      'reports:view',
      'reports:deal:view',
      'tags:view',
      'files:view',
      'files:create',
    ],
  },
  {
    systemKey: 'sys.support_agent',
    name: 'Support Agent',
    description: 'Handle tickets and customer conversations.',
    color: '#06b6d4',
    version: 1,
    permissions: [
      'tickets:view',
      'tickets:create',
      'tickets:edit',
      'tickets:resolve',
      'contacts:view',
      'accounts:view',
      'tasks:view',
      'tasks:create',
      'tasks:edit',
      'reports:view',
      'reports:ticket:view',
      'tags:view',
      'files:view',
      'omni_channel:view',
      'omni_reports:view',
    ],
  },
  {
    systemKey: 'sys.read_only',
    name: 'Read Only',
    description:
      'See everything the workspace exposes, change nothing. The safe default for a new teammate.',
    color: '#64748b',
    version: 1,
    permissions: [],
    dynamic: 'all_view',
  },
  {
    systemKey: 'sys.marketing',
    name: 'Marketing',
    description: 'Plan and launch campaigns, manage the content library.',
    color: '#ec4899',
    version: 1,
    requiresFeature: 'campaigns:view',
    permissions: [
      'campaigns:view',
      'campaigns:create',
      'campaigns:edit',
      'campaigns:launch',
      'contacts:view',
      'leads:view',
      'reports:view',
      'reports:contact:view',
      'tags:view',
      'files:view',
      'files:create',
    ],
  },
];

/**
 * The Administrator pseudo-role. Not stored — the tenant `ADMIN` role flag is
 * the real grant. Exposed so the frontend can render it in the roles list
 * instead of leaving the most powerful role in the tenant invisible.
 */
export const ADMINISTRATOR_PSEUDO_ROLE = {
  systemKey: 'sys.administrator',
  name: 'Administrator',
  description:
    'Full access to everything the workspace is entitled to, including settings and billing. Granted per user, not by assigning this role.',
  color: '#f59e0b',
} as const;

export const SYSTEM_ROLE_KEYS = SYSTEM_ROLE_TEMPLATES.map((t) => t.systemKey);

/** The role a newly invited user gets when the inviter picks nothing. */
export const DEFAULT_BASELINE_SYSTEM_KEY = 'sys.read_only';

/**
 * Resolve a template's permission list against a tenant ceiling.
 * Keys outside the ceiling are dropped here — deliberately, and visibly — so a
 * materialised role never claims a permission the engine would ignore.
 */
export const resolveTemplatePermissions = (
  template: SystemRoleTemplate,
  tenantCeiling: Set<string>,
): string[] => {
  if (template.dynamic === 'all_view') {
    return [...tenantCeiling].filter((key) => key.endsWith(':view')).sort();
  }
  return template.permissions.filter((key) => tenantCeiling.has(key));
};
