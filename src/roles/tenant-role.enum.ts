/**
 * A member's tier within one tenant.
 *
 * Only these three exist because only these three are read anywhere. VIEWER and
 * GUEST were enum entries and nothing else: no guard, engine or query ever
 * looked at them, so assigning one produced a member with no permissions and no
 * explanation. Read-only access is a role (`sys.read_only`), not a tier.
 *
 * The tier is deliberately coarse. What a member may DO comes from their roles;
 * this only distinguishes the two principals that hold the entire tenant
 * ceiling from everyone who does not.
 */
export enum TenantRoleEnum {
  /** Derived from `tenant.ownerId`. Cannot be granted or revoked here. */
  OWNER = 'OWNER',
  /** Holds the whole ceiling. Grantable only by someone who already does. */
  ADMIN = 'ADMIN',
  /** Everyone else. Access comes entirely from assigned roles. */
  MEMBER = 'MEMBER',
}
