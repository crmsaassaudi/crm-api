/**
 * Injection tokens for the authorization services that are resolved lazily
 * through `ModuleRef` rather than constructor-injected.
 *
 * Three services in this folder form an unavoidable runtime cycle:
 *
 *   CustomRolesService ──(grant invariant: "you cannot grant what you do not
 *                         hold")──▶ AuthzPermissionCacheService
 *   AuthzPermissionCacheService ──(role expansion / active grants)──▶
 *                         CustomRolesService, RoleAssignmentService
 *   RoleAssignmentService ──(role must exist in tenant)──▶ CustomRolesService
 *
 * `ModuleRef` breaks the *DI* cycle, but importing the class to use it as a
 * lookup key keeps the *module* cycle alive — and with `emitDecoratorMetadata`
 * a class referenced in another service's constructor signature is evaluated at
 * require time, so whichever file loads first hits its own half-initialised
 * binding: `ReferenceError: Cannot access 'CustomRolesService' before
 * initialization` at bootstrap.
 *
 * Keying the lazy lookups on symbols declared in this import-free leaf module
 * removes those edges entirely. This file must never import anything.
 */

/** {@link AuthzPermissionCacheService} — the cached effective-permission engine. */
export const AUTHZ_PERMISSION_CACHE = Symbol('AUTHZ_PERMISSION_CACHE');

/** {@link CustomRolesService} — the tenant custom-role catalog. */
export const CUSTOM_ROLES_SERVICE = Symbol('CUSTOM_ROLES_SERVICE');

/** {@link RoleAssignmentService} — governed, time-bounded role grants. */
export const ROLE_ASSIGNMENT_SERVICE = Symbol('ROLE_ASSIGNMENT_SERVICE');
