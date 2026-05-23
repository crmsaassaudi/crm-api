export type PermissionResource =
  | 'leads'
  | 'contacts'
  | 'accounts'
  | 'deals'
  | 'campaigns'
  | 'tickets'
  | 'reports'
  | 'users'
  | 'groups'
  | 'settings'
  | 'tasks'
  | 'ai_video'
  | 'social_content_assets'
  | 'publication_instances';

export type PermissionAction =
  | 'view'
  | 'create'
  | 'edit'
  | 'delete'
  | 'export'
  | 'import'
  | 'unmask'
  | 'assign'
  | 'move_stage'
  | 'launch'
  | 'resolve'
  | 'manage_roles'
  | 'manage_members'
  | 'manage_billing'
  | 'manage_system'
  | 'approve'
  | 'cancel'
  | 'retry'
  | 'publish';

export type PermissionRule = {
  action: PermissionAction;
  resource: PermissionResource;
};

export const PERMISSION_REGISTRY: Record<
  PermissionResource,
  Partial<Record<PermissionAction, string>>
> = {
  leads: {
    view: 'leads:view',
    create: 'leads:create',
    edit: 'leads:edit',
    delete: 'leads:delete',
    export: 'leads:export',
    import: 'leads:import',
    assign: 'leads:assign',
  },
  contacts: {
    view: 'contacts:view',
    create: 'contacts:create',
    edit: 'contacts:edit',
    delete: 'contacts:delete',
    export: 'contacts:export',
    import: 'contacts:import',
    unmask: 'contacts:unmask',
  },
  accounts: {
    view: 'accounts:view',
    create: 'accounts:create',
    edit: 'accounts:edit',
    delete: 'accounts:delete',
    export: 'accounts:export',
  },
  deals: {
    view: 'deals:view',
    create: 'deals:create',
    edit: 'deals:edit',
    delete: 'deals:delete',
    move_stage: 'deals:move_stage',
  },
  campaigns: {
    view: 'campaigns:view',
    create: 'campaigns:create',
    edit: 'campaigns:edit',
    delete: 'campaigns:delete',
    launch: 'campaigns:launch',
  },
  tickets: {
    view: 'tickets:view',
    create: 'tickets:create',
    edit: 'tickets:edit',
    delete: 'tickets:delete',
    resolve: 'tickets:resolve',
  },
  reports: {
    view: 'reports:view',
    create: 'reports:create',
    export: 'reports:export',
  },
  users: {
    view: 'users:view',
    create: 'users:create',
    edit: 'users:edit',
    delete: 'users:delete',
    manage_roles: 'users:manage_roles',
  },
  groups: {
    view: 'groups:view',
    create: 'groups:create',
    edit: 'groups:edit',
    delete: 'groups:delete',
    manage_members: 'groups:manage_members',
  },
  settings: {
    view: 'settings:view',
    manage_billing: 'settings:manage_billing',
    manage_system: 'settings:manage_system',
  },
  tasks: {
    view: 'tasks:view',
    create: 'tasks:create',
    edit: 'tasks:edit',
    delete: 'tasks:delete',
  },
  ai_video: {
    view: 'ai_video:view',
    create: 'ai_video:create',
    edit: 'ai_video:edit',
    delete: 'ai_video:delete',
    manage_system: 'ai_video:manage_system',
  },
  social_content_assets: {
    view: 'social_content_assets:view',
    create: 'social_content_assets:create',
    edit: 'social_content_assets:edit',
    delete: 'social_content_assets:delete',
    approve: 'social_content_assets:approve',
  },
  publication_instances: {
    view: 'publication_instances:view',
    create: 'publication_instances:create',
    edit: 'publication_instances:edit',
    cancel: 'publication_instances:cancel',
    retry: 'publication_instances:retry',
    publish: 'publication_instances:publish',
  },
};

/**
 * ALL_PERMISSIONS: Complete set of every permission key in the registry.
 * Used as the superset for type-checking and seeding.
 */
export const ALL_PERMISSIONS = Object.values(PERMISSION_REGISTRY).flatMap(
  (resource) => Object.values(resource).filter(Boolean) as string[],
);

/**
 * CORE_PERMISSIONS: The default permission set automatically available to
 * every tenant Owner/Admin without explicit granting.
 *
 * Add a permission here to make it universally available to all Owners.
 * Remove it from here (and place in FEATURE_PERMISSIONS) to gate it
 * so it must be explicitly enabled per-tenant.
 */
export const CORE_PERMISSIONS: string[] = [
  // Leads
  'leads:view',
  'leads:create',
  'leads:edit',
  'leads:delete',
  'leads:assign',
  // Contacts
  'contacts:view',
  'contacts:create',
  'contacts:edit',
  'contacts:delete',
  // Accounts
  'accounts:view',
  'accounts:create',
  'accounts:edit',
  'accounts:delete',
  // Deals
  'deals:view',
  'deals:create',
  'deals:edit',
  'deals:delete',
  'deals:move_stage',
  // Tickets
  'tickets:view',
  'tickets:create',
  'tickets:edit',
  'tickets:delete',
  'tickets:resolve',
  // Tasks
  'tasks:view',
  'tasks:create',
  'tasks:edit',
  'tasks:delete',
  // Reports (view only by default)
  'reports:view',
  // Users & Groups management
  'users:view',
  'users:create',
  'users:edit',
  'users:delete',
  'users:manage_roles',
  'groups:view',
  'groups:create',
  'groups:edit',
  'groups:delete',
  'groups:manage_members',
  // Settings
  'settings:view',
  'settings:manage_billing',
  'settings:manage_system',
  // AI Video
  'ai_video:view',
  'ai_video:create',
  'ai_video:edit',
  'ai_video:delete',
  'ai_video:manage_system',
];

/**
 * FEATURE_PERMISSIONS: Permissions that must be explicitly granted to a
 * specific Tenant's `availablePermissions` field in the database.
 *
 * Use this for: Beta features, Premium add-ons, Partner-only capabilities.
 *
 * To enable for ONE tenant: add the key to that tenant's `availablePermissions`
 * array in MongoDB (merged on top of CORE_PERMISSIONS).
 *
 * To enable for ALL tenants: move the key into CORE_PERMISSIONS above.
 */
export const FEATURE_PERMISSIONS: string[] = [
  // Data import/export — may require billing tier
  'leads:export',
  'leads:import',
  'contacts:export',
  'contacts:import',
  'contacts:unmask',
  'accounts:export',
  // Reports advanced
  'reports:create',
  'reports:export',
  // Campaigns — gated feature
  'campaigns:view',
  'campaigns:create',
  'campaigns:edit',
  'campaigns:delete',
  'campaigns:launch',
  // Social Content Library
  'social_content_assets:view',
  'social_content_assets:create',
  'social_content_assets:edit',
  'social_content_assets:delete',
  'social_content_assets:approve',
  'publication_instances:view',
  'publication_instances:create',
  'publication_instances:edit',
  'publication_instances:cancel',
  'publication_instances:retry',
  'publication_instances:publish',
];

export const getPermissionKey = (
  action: PermissionAction,
  resource: PermissionResource,
) => PERMISSION_REGISTRY[resource]?.[action] ?? null;
