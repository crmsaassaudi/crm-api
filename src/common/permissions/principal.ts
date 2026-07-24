/**
 * Principal — the authenticated actor behind a request.
 *
 * The authorization stack was originally human-only (every subject was a user
 * resolved from a JWT `sub`). Enterprise workloads add non-human actors:
 *   - `service` — a machine/service account (integrations, server-to-server).
 *   - `agent`   — an AI agent / workflow bot acting on a tenant's behalf.
 *
 * Making the actor kind explicit lets the PDP, audit trail, ABAC conditions
 * and field-masking branch on WHO is acting — e.g. an AI agent may be scoped
 * more tightly than the user who configured it, and audit must attribute the
 * change to the agent, not to "system".
 *
 * NOTE: this is the *subject* identity. It is distinct from ObjectAcl's
 * `principalType` (`user | group`) which describes the *target* of a grant.
 */
export enum PrincipalType {
  USER = 'user',
  SERVICE = 'service',
  AGENT = 'agent',
}

export interface Principal {
  type: PrincipalType;
  /** Stable id: Mongo user id, service-account id, or agent id. */
  id: string;
  tenantId?: string;
  displayName?: string | null;
}

const PRINCIPAL_TYPE_VALUES = new Set<string>(Object.values(PrincipalType));

/**
 * Determine the principal kind from a verified (signed) token payload.
 *
 * Precedence:
 *   1. An explicit, trusted `principal_type` claim (issued by our own auth for
 *      agents/services) — only honored when it is a known kind.
 *   2. A Keycloak service-account access token — `preferred_username` of the
 *      form `service-account-<client>` with no interactive user — is a service.
 *   3. Otherwise a human user.
 *
 * Fails safe to USER: an unknown/garbage claim never silently downgrades the
 * actor into a more-privileged branch — USER is the most-scrutinized path.
 */
export function resolvePrincipalType(claims: any): PrincipalType {
  const explicit = claims?.principal_type;
  if (typeof explicit === 'string' && PRINCIPAL_TYPE_VALUES.has(explicit)) {
    return explicit as PrincipalType;
  }

  const username: string | undefined = claims?.preferred_username;
  if (
    typeof username === 'string' &&
    username.startsWith('service-account-')
  ) {
    return PrincipalType.SERVICE;
  }

  return PrincipalType.USER;
}
