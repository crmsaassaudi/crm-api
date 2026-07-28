export type PermissionResource =
  | 'leads'
  | 'contacts'
  | 'accounts'
  | 'deals'
  | 'campaigns'
  | 'tickets'
  | 'reports'
  | 'contact_reports'
  | 'deal_reports'
  | 'ticket_reports'
  | 'agent_reports'
  | 'users'
  | 'groups'
  | 'org_units'
  | 'settings'
  | 'tasks'
  | 'ai_video'
  | 'social_content_assets'
  | 'publication_instances'
  | 'audit_logs'
  | 'email_settings'
  | 'email_integrations'
  | 'automation_rules'
  | 'automation_logs'
  | 'integration_monitoring'
  | 'channels'
  | 'tags'
  | 'sla_policies'
  | 'routing_rules'
  | 'files'
  | 'storage'
  | 'omni_channel'
  | 'omni_reports'
  | 'all_data';

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
  contact_reports: {
    view: 'reports:contact:view',
    export: 'reports:contact:export',
  },
  deal_reports: {
    view: 'reports:deal:view',
    export: 'reports:deal:export',
  },
  ticket_reports: {
    view: 'reports:ticket:view',
    export: 'reports:ticket:export',
  },
  agent_reports: {
    view: 'reports:agent:view',
    export: 'reports:agent:export',
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
  // The org tree that ORG_UNIT / ORG_UNIT_SUBTREE data scopes are keyed on.
  // Separate from `groups` on purpose: a group is a collaboration set, an org
  // unit decides who owns which records, so the two must be grantable apart.
  org_units: {
    view: 'org_units:view',
    create: 'org_units:create',
    edit: 'org_units:edit',
    delete: 'org_units:delete',
  },
  settings: {
    view: 'settings:view',
    manage_billing: 'settings:manage_billing',
    manage_system: 'settings:manage_system',
    approve: 'settings:approve_access',
  },
  /**
   * Read every record in the tenant, bypassing the data-visibility axes.
   *
   * Exists so "who can see everything" is a role a tenant can grant and audit,
   * rather than being welded to the built-in ADMIN/OWNER roles. An auditor or a
   * head of sales often needs a full read without also getting the ability to
   * manage users and billing, which is the only thing ADMIN could express
   * before. It grants READ breadth only — it is not a permission to act on
   * those records, which each module still checks separately.
   */
  all_data: {
    view: 'all_data:view',
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
  audit_logs: {
    view: 'audit_logs:view',
  },
  email_settings: {
    view: 'email_settings:view',
    edit: 'email_settings:edit',
    delete: 'email_settings:delete',
    manage_system: 'email_settings:manage_system',
  },
  email_integrations: {
    view: 'email_integrations:view',
    create: 'email_integrations:create',
    edit: 'email_integrations:edit',
    manage_system: 'email_integrations:manage_system',
  },
  automation_rules: {
    view: 'automation_rules:view',
    create: 'automation_rules:create',
    edit: 'automation_rules:edit',
    delete: 'automation_rules:delete',
  },
  automation_logs: {
    view: 'automation_logs:view',
    retry: 'automation_logs:retry',
  },
  integration_monitoring: {
    view: 'integration_monitoring:view',
  },
  channels: {
    view: 'channels:view',
    create: 'channels:create',
    edit: 'channels:edit',
    delete: 'channels:delete',
    manage_system: 'channels:manage_system',
  },
  tags: {
    view: 'tags:view',
    create: 'tags:create',
    edit: 'tags:edit',
    delete: 'tags:delete',
  },
  sla_policies: {
    view: 'sla_policies:view',
    create: 'sla_policies:create',
    edit: 'sla_policies:edit',
    delete: 'sla_policies:delete',
  },
  routing_rules: {
    view: 'routing_rules:view',
    create: 'routing_rules:create',
    edit: 'routing_rules:edit',
    delete: 'routing_rules:delete',
  },
  files: {
    view: 'files:view',
    create: 'files:create',
    edit: 'files:edit',
    delete: 'files:delete',
  },
  storage: {
    view: 'storage:view',
    manage_system: 'storage:manage_system',
  },
  omni_channel: {
    view: 'omni_channel:view',
    /** Mutate a conversation: tags, notes, read state, message linking. */
    edit: 'omni_channel:edit',
    /** Claim / assign / unassign a conversation to an agent or group. */
    assign: 'omni_channel:assign',
    /** Tenant-wide omni settings and storage quota. */
    manage_system: 'omni_channel:manage_system',
  },
  omni_reports: {
    view: 'omni_reports:view',
    export: 'omni_reports:export',
  },
};

/**
 * ALL_PERMISSIONS: Complete set of every permission key in the registry.
 * Used as the superset for type-checking and seeding.
 */
export const ALL_PERMISSIONS = Object.values(PERMISSION_REGISTRY).flatMap(
  (resource) => Object.values(resource).filter(Boolean),
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
  'reports:contact:view',
  'reports:deal:view',
  'reports:ticket:view',
  'reports:agent:view',
  // Users, Groups & Org units management
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
  'org_units:view',
  'org_units:create',
  'org_units:edit',
  'org_units:delete',
  // Settings
  'settings:view',
  'settings:manage_billing',
  'settings:manage_system',
  'settings:approve_access',
  // AI Video
  'ai_video:view',
  'ai_video:create',
  'ai_video:edit',
  'ai_video:delete',
  'ai_video:manage_system',
  // Audit Logs
  'audit_logs:view',
  // Email Settings & Integrations
  'email_settings:view',
  'email_settings:edit',
  'email_settings:delete',
  'email_settings:manage_system',
  'email_integrations:view',
  'email_integrations:create',
  'email_integrations:edit',
  'email_integrations:manage_system',
  // Automation Rules & Logs
  'automation_rules:view',
  'automation_rules:create',
  'automation_rules:edit',
  'automation_rules:delete',
  'automation_logs:view',
  'automation_logs:retry',
  // Integration Monitoring
  'integration_monitoring:view',
  // Channels (Omni messaging providers)
  'channels:view',
  'channels:create',
  'channels:edit',
  'channels:delete',
  'channels:manage_system',
  // Tags
  'tags:view',
  'tags:create',
  'tags:edit',
  'tags:delete',
  // SLA Policies
  'sla_policies:view',
  'sla_policies:create',
  'sla_policies:edit',
  'sla_policies:delete',
  // Routing Rules
  'routing_rules:view',
  'routing_rules:create',
  'routing_rules:edit',
  'routing_rules:delete',
  // Files / Cloud Drive
  'files:view',
  'files:create',
  'files:edit',
  'files:delete',
  // Storage (OWNER dashboard — view-only by default)
  'storage:view',
  // Omni-Channel page access
  'omni_channel:view',
  'omni_channel:edit',
  'omni_channel:assign',
  'omni_channel:manage_system',
  // Omni-Channel Reports
  'omni_reports:view',
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
  'reports:contact:export',
  'reports:deal:export',
  'reports:ticket:export',
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
  // Omni-Channel Reports export
  'omni_reports:export',
  // Bypass every data-visibility axis. Feature-gated rather than core on
  // purpose: a permission that reveals the whole tenant should be something an
  // operator turns on deliberately, not something sitting in every tenant's
  // catalogue waiting to be ticked by accident.
  'all_data:view',
];

export const getPermissionKey = (
  action: PermissionAction,
  resource: PermissionResource,
) => PERMISSION_REGISTRY[resource]?.[action] ?? null;
