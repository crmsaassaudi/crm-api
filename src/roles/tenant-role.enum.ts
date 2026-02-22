export enum TenantRoleEnum {
  OWNER = 'OWNER', // Created the tenant, full control
  ADMIN = 'ADMIN', // Tenant administrator
  MEMBER = 'MEMBER', // Regular team member
  VIEWER = 'VIEWER', // Read-only access
  GUEST = 'GUEST', // Minimal/temporary access
}
