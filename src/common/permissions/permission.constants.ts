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
  | 'tasks';

export type PermissionAction =
  | 'view'
  | 'create'
  | 'edit'
  | 'delete'
  | 'export'
  | 'import'
  | 'assign'
  | 'move_stage'
  | 'launch'
  | 'resolve'
  | 'manage_roles'
  | 'manage_members'
  | 'manage_billing'
  | 'manage_system';

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
};

export const ALL_PERMISSIONS = Object.values(PERMISSION_REGISTRY).flatMap(
  (resource) => Object.values(resource).filter(Boolean) as string[],
);

export const getPermissionKey = (
  action: PermissionAction,
  resource: PermissionResource,
) => PERMISSION_REGISTRY[resource]?.[action] ?? null;
