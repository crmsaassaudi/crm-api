/**
 * Route authorization coverage gate (finding C-05).
 *
 * `PermissionGuard.canActivate` returns TRUE when a handler carries no
 * `@RequirePermission` metadata (permission.guard.ts:37). The guard is global,
 * so the default posture for a new endpoint is *authenticated-but-unauthorized*
 * — anyone with a session can call it.
 *
 * This test enumerates every HTTP handler in the codebase by static analysis
 * and requires each one to declare its authorization posture explicitly:
 *
 *   @RequirePermission(action, resource)   RBAC-gated (the normal case)
 *   @Roles(...)                            platform-role gated
 *   @TenantRoles(...)                      tenant-role gated
 *   @Unprotected() / @Public()             deliberately anonymous
 *   PUBLIC_CONTROLLERS allowlist below     reviewed, justified exception
 *
 * Anything else fails the build. Static analysis is deliberate: it needs no
 * database, no Nest bootstrap and no running app, so it can gate every PR in
 * seconds — and it catches a missing decorator at the moment it is written
 * rather than when someone thinks to probe the endpoint.
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

const SRC_ROOT = join(__dirname, '..', '..', '..');

const HTTP_DECORATOR = /@(Get|Post|Put|Patch|Delete|Head|Options|All)\s*\(/g;

const AUTHZ_DECORATORS = [
  'RequirePermission',
  'RequireAnyPermission',
  'RequirePermissions',
  'Roles',
  'TenantRoles',
  'Unprotected',
  'Public',
  'UseAcl',
];

/**
 * Controllers that are intentionally not RBAC-gated. Every entry needs a
 * reason, and adding one is a security review — that is the point of keeping
 * the list here rather than inferring it.
 */
const PUBLIC_CONTROLLERS: Record<string, string> = {
  'health/health.controller.ts': 'liveness/readiness probes, no data',
  'home/home.controller.ts': 'static service banner',
  'observability/metrics.controller.ts':
    'Prometheus scrape endpoint, network-restricted',
  'common/http/resilience-metrics.controller.ts':
    'internal resilience counters, network-restricted',
  'auth/auth.controller.ts':
    'OIDC login/callback/refresh/logout — pre-authentication by definition',
  'tenants/controllers/internal-tenants.controller.ts':
    'InternalApiKeyGuard (service-to-service)',
  'omni-inbound/bot/internal-channels.controller.ts':
    'InternalApiKeyGuard (crm-bot callback)',
  'tenants/controllers/onboarding.controller.ts':
    'pre-tenant onboarding — no tenant context exists yet',
  'omni-inbound/controllers/inbound.controller.ts':
    'provider webhooks, signature-verified',
  'omni-inbound/bot/bot-callback.controller.ts':
    'crm-bot webhook, signature-verified',
  'channels/email-tracking.controller.ts':
    'open/click pixel — anonymous by design',
  'livechat/livechat-embed.controller.ts':
    'public widget embed script (anonymous visitors)',
  'files/infrastructure/uploader/local/files.controller.ts':
    'signed file download',
  'files/infrastructure/uploader/s3/files.controller.ts':
    'signed file download',
  'files/infrastructure/uploader/s3-presigned/files.controller.ts':
    'signed file download',
};

/**
 * Controllers with a KNOWN missing-authorization gap (C-05). Each entry is a
 * release blocker, not an exemption: the test asserts the list is EXACTLY this,
 * so removing a decorator elsewhere still fails, and fixing one of these fails
 * until it is removed from the list. The list must reach empty before release.
 */
const KNOWN_UNGATED_C05: string[] = [
  // EMPTY — every controller now declares its authorization posture.
  // The two former debug controllers (activity-log/test-event,
  // common/http/test-http) were DELETED rather than gated: unauthenticated
  // event-injection and outbound-HTTP probes have no place in a deployed app.
];

/**
 * Controllers whose EVERY handler is self-scoped: authenticated, but with no
 * permission check because the subject is the caller, taken from CLS rather than
 * from a path or query parameter. There is no id to tamper with and no
 * authorization decision beyond "is this request authenticated".
 *
 * A separate list from PUBLIC_CONTROLLERS on purpose. "Public" means reachable
 * without authentication, which is a much stronger claim; filing an
 * authenticated self-scoped controller there would make the public surface look
 * larger than it is and blunt the review that list exists to force. And it is
 * not KNOWN_UNGATED_C05 either, because that list is release blockers that must
 * shrink to empty — these are correct as they stand.
 *
 * The bar for an entry: the handler must be incapable of naming another subject.
 * A route that takes `:id` and compares it to the caller does NOT qualify — that
 * is an authorization decision, and it belongs behind a decorator.
 */
const SELF_SCOPED_CONTROLLERS: Record<string, string> = {
  'common/permissions/me-permissions.controller.ts':
    "returns the caller's own effective permissions; subject read from CLS, no id parameter exists",
};

/**
 * Handlers that are authenticated but intentionally not permission-gated
 * because they act only on the caller's own identity. `key` is
 * `<controller-path>#<handlerName>`.
 */
const SELF_SCOPED_HANDLERS = new Set([
  'auth/auth.controller.ts#me',
  'auth/auth.controller.ts#myTenants',
  'auth/auth.controller.ts#update',
  'auth/auth.controller.ts#delete',
  'users/users.controller.ts#getMyI18n',
  'users/users.controller.ts#updateMyI18n',
  'home/home.controller.ts#appInfo',
  'livechat/livechat-embed.controller.ts#getEmbedSnippet',
  // Onboarding runs before a tenant/permission context exists.
  'tenants/controllers/onboarding.controller.ts#getContext',
  'tenants/controllers/onboarding.controller.ts#updateContext',
  'tenants/controllers/onboarding.controller.ts#complete',
  'tenants/controllers/onboarding.controller.ts#getStatus',
  'tenants/controllers/onboarding.controller.ts#retryProvisioning',
  'tenants/tenants.controller.ts#onboardExistingUser',
]);

/**
 * KNOWN partially-gated handlers — each is an open mutating endpoint on an
 * otherwise-protected controller, which is the most dangerous shape because the
 * controller reads as protected. Release blockers, not exemptions.
 *
 * `omni.controller.ts#assignAgent` / `#claimConversation` are the sharpest:
 * conversation row visibility is keyed on `assignedAgentId` / `claimedById`
 * (conversation.repository.ts:287), so an ungated self-assignment endpoint lets
 * any authenticated member grant themselves read access to any conversation in
 * the tenant, one id at a time (finding C-06).
 *
 * `files/*#hardDelete*` guard on `cls.get('tenantRole')`, a CLS key that NO code
 * ever writes — every role branch in the files/folders module is permanently
 * false (finding M-15). Fail-closed today; a single `cls.set('tenantRole', …)`
 * would silently activate ~14 never-exercised privilege branches.
 */
const KNOWN_PARTIAL_C05: string[] = [
  // EMPTY — C-05 and C-06 are remediated. Every handler on an otherwise
  // protected controller now declares a permission.
];

interface ControllerReport {
  file: string;
  handlerCount: number;
  gatedCount: number;
  ungatedHandlers: string[];
  /** Members carrying two route decorators or two `@RequirePermission`s. */
  doubledDecorators: string[];
  /** Members using `@Param`/`@Body`/`@Query` with no method decorator at all. */
  orphanedHandlers: string[];
}

/** Nest parameter decorators — only ever used on a route handler. */
const PARAM_DECORATOR = /@(Param|Body|Query|Res|Req|UploadedFile|Headers)\s*\(/;

/** `name(` / `async name(` at the start of a line: a class member declaration. */
const MEMBER_DECLARATION =
  /^(?:public\s+|async\s+|static\s+)*[A-Za-z_$][\w$]*\s*(?:<[^>]*>)?\s*\(/;

function findControllers(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      findControllers(full, found);
    } else if (entry.endsWith('.controller.ts') && !entry.includes('.spec.')) {
      found.push(full);
    }
  }
  return found;
}

/**
 * Attribute each decorator block to the member it precedes.
 *
 * Decorators in this codebase are frequently multi-line (`@ApiOperation({...})`
 * spanning four lines with `@RequirePermission` underneath), so naive
 * line-adjacency scanning silently loses the authorization decorator and
 * reports a gated handler as open. Paren-depth tracking consumes each decorator
 * as one unit regardless of how many lines it occupies.
 */
function analyzeController(absolutePath: string): ControllerReport {
  const source = readFileSync(absolutePath, 'utf8');
  const file = relative(SRC_ROOT, absolutePath).replace(/\\/g, '/');
  const lines = source.split('\n');

  const hasAuthz = (text: string) =>
    AUTHZ_DECORATORS.some((decorator) =>
      new RegExp(`@${decorator}\\s*[(\\s]`).test(text),
    );
  const hasHttp = (text: string) => {
    HTTP_DECORATOR.lastIndex = 0;
    return HTTP_DECORATOR.test(text);
  };

  const ungatedHandlers: string[] = [];
  const doubledDecorators: string[] = [];
  const orphanedHandlers: string[] = [];
  let handlerCount = 0;
  let gatedCount = 0;
  let classLevelAuthz = false;

  let pending: string[] = [];
  let depth = 0;

  const netParens = (line: string) =>
    (line.match(/\(/g)?.length ?? 0) - (line.match(/\)/g)?.length ?? 0);

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const trimmed = line.trim();

    // Mid-decorator continuation — consume regardless of what it looks like.
    if (depth > 0) {
      pending.push(line);
      depth += netParens(line);
      continue;
    }

    if (trimmed.startsWith('@')) {
      pending.push(line);
      depth += netParens(line);
      continue;
    }

    // Comments and blank lines separate members; a decorator is always
    // immediately adjacent to what it decorates.
    if (
      trimmed === '' ||
      trimmed.startsWith('//') ||
      trimmed.startsWith('/*') ||
      trimmed.startsWith('*')
    ) {
      if (trimmed === '') pending = [];
      continue;
    }

    const block = pending.join('\n');
    pending = [];

    if (/^export\s+(?:abstract\s+)?class\s/.test(trimmed)) {
      classLevelAuthz = hasAuthz(block);
      continue;
    }

    const memberName =
      trimmed.match(
        /(?:public |private |protected |async |static )*(\w+)\s*\(/,
      )?.[1] ?? `line:${index + 1}`;

    if (!hasHttp(block)) {
      // A member using Nest parameter decorators with NO method decorator is not
      // a route: Nest never registers it, and every caller silently 404s. Always
      // a mistake — see `doubledDecorators` for how one is produced.
      const signature = lines.slice(index, index + 5).join(' ');
      if (
        block.trim() === '' &&
        // The line must itself open a member declaration. Without this, a
        // continuation line inside a multi-line handler signature matches the
        // window test and every wrapped parameter reads as an orphan.
        MEMBER_DECLARATION.test(trimmed) &&
        PARAM_DECORATOR.test(signature) &&
        !/^(constructor|private |protected )/.test(trimmed)
      ) {
        orphanedHandlers.push(`${memberName} (line ${index + 1})`);
      }
      continue;
    }

    handlerCount++;

    // Two route decorators, or two `@RequirePermission`s, on one member.
    //
    // How this happens: a JSDoc comment written BETWEEN a handler's decorators
    // and its signature. Comments separate members here — exactly as Nest's own
    // metadata does not — so the decorators above the comment fall through onto
    // the NEXT member, which ends up with two of everything while the member
    // they belonged to has none. `AccountsController` shipped in that state:
    // `@Get()` + `@RequirePermission('view','accounts')` landed on
    // `checkDuplicate`, `findAll` stopped being a route, and `GET /v1/accounts`
    // answered `{ isDuplicate: false, duplicates: [] }` instead of the account
    // list. Both halves are silent — Nest registers the last path decorator and
    // the orphan simply never resolves — so nothing fails until a user notices
    // an empty list.
    HTTP_DECORATOR.lastIndex = 0;
    const routeDecorators = block.match(HTTP_DECORATOR)?.length ?? 0;
    const permissionDecorators =
      block.match(/@RequirePermission\s*\(/g)?.length ?? 0;
    if (routeDecorators > 1 || permissionDecorators > 1) {
      doubledDecorators.push(
        `${memberName} (line ${index + 1}): ${routeDecorators} route / ` +
          `${permissionDecorators} permission decorators`,
      );
    }

    if (classLevelAuthz || hasAuthz(block)) gatedCount++;
    else ungatedHandlers.push(`${memberName} (line ${index + 1})`);
  }

  return {
    file,
    handlerCount,
    gatedCount,
    ungatedHandlers,
    doubledDecorators,
    orphanedHandlers,
  };
}

const REPORTS = findControllers(SRC_ROOT)
  .map(analyzeController)
  // Orphan-only controllers are kept: a file whose every route decorator drifted
  // onto the wrong member is precisely what must not be filtered out of the report.
  .filter(
    (report) => report.handlerCount > 0 || report.orphanedHandlers.length > 0,
  )
  .sort((left, right) => left.file.localeCompare(right.file));

describe('API route authorization coverage (C-05)', () => {
  it('should discover the controller surface', () => {
    expect(REPORTS.length).toBeGreaterThan(50);
    const handlers = REPORTS.reduce((sum, r) => sum + r.handlerCount, 0);
    expect(handlers).toBeGreaterThan(200);
  });

  it('should keep every allowlist entry pointing at a controller that still exists', () => {
    const known = new Set(REPORTS.map((report) => report.file));
    const stale = [
      ...Object.keys(PUBLIC_CONTROLLERS),
      ...Object.keys(SELF_SCOPED_CONTROLLERS),
      ...KNOWN_UNGATED_C05,
    ].filter((file) => !known.has(file));
    // Prevents the allowlist from rotting into a permanent blanket exemption
    // after a file is renamed or deleted.
    expect(stale).toEqual([]);
  });

  it('should keep the set of ungated controllers EXACTLY the reviewed lists', () => {
    const ungated = REPORTS.filter(
      (report) => report.gatedCount === 0 && report.handlerCount > 0,
    ).map((report) => report.file);

    const accounted = new Set([
      ...Object.keys(PUBLIC_CONTROLLERS),
      ...Object.keys(SELF_SCOPED_CONTROLLERS),
      ...KNOWN_UNGATED_C05,
    ]);

    const unexpected = ungated.filter((file) => !accounted.has(file));
    const fixed = KNOWN_UNGATED_C05.filter((file) => !ungated.includes(file));

    // A NEW undeclared controller fails here — that is the regression gate.
    expect({ unexpected }).toEqual({ unexpected: [] });
    // A FIXED controller also fails here, with instructions. Deliberate: the
    // list must shrink to empty and each removal is a reviewed event.
    expect({
      nowGatedRemoveFromKnownUngated: fixed,
    }).toEqual({ nowGatedRemoveFromKnownUngated: [] });
  });

  it('should not let a partially-gated controller leave an UNREVIEWED handler open', () => {
    // The most dangerous shape: a controller that reads as protected because
    // most handlers are decorated, with one that was forgotten.
    const openHandlers = REPORTS.flatMap((report) =>
      report.ungatedHandlers.map(
        (handler) => `${report.file}#${handler.replace(/ \(line \d+\)$/, '')}`,
      ),
    );

    const accounted = new Set([
      ...SELF_SCOPED_HANDLERS,
      ...KNOWN_PARTIAL_C05,
      // Wholly-ungated controllers are covered by the previous assertion.
      ...REPORTS.filter((report) => report.gatedCount === 0).flatMap((report) =>
        report.ungatedHandlers.map(
          (handler) =>
            `${report.file}#${handler.replace(/ \(line \d+\)$/, '')}`,
        ),
      ),
    ]);

    const unreviewed = openHandlers.filter(
      (handler) => !accounted.has(handler),
    );
    expect({ unreviewed }).toEqual({ unreviewed: [] });
  });

  it('should keep every KNOWN_PARTIAL_C05 handler open (list must shrink to empty)', () => {
    const openHandlers = new Set(
      REPORTS.flatMap((report) =>
        report.ungatedHandlers.map(
          (handler) =>
            `${report.file}#${handler.replace(/ \(line \d+\)$/, '')}`,
        ),
      ),
    );
    const nowGated = KNOWN_PARTIAL_C05.filter(
      (handler) => !openHandlers.has(handler),
    );
    // Fails when a gap is fixed, so the remediation list cannot silently rot.
    // Remove the entry from KNOWN_PARTIAL_C05 in the same commit as the fix.
    expect({ nowGatedRemoveFromKnownPartial: nowGated }).toEqual({
      nowGatedRemoveFromKnownPartial: [],
    });
  });

  /**
   * EXPECTED RED until C-06 is remediated. This assertion is left failing on
   * purpose: it is a release blocker, and the honest CI representation of
   * "must not ship" is a red test — not a skip, and not an allowlist entry that
   * makes the gap look accounted for. Delete nothing; add the decorators.
   */
  it('should require a permission on every conversation assignment endpoint (C-06)', () => {
    // Called out separately because it is not merely a missing decorator — it
    // is a self-service read-access escalation. Conversation visibility is
    // keyed on assignedAgentId/claimedById, so an ungated assign endpoint lets
    // any member make any conversation visible to themselves.
    const omni = REPORTS.find((report) =>
      report.file.endsWith('omni-inbound/controllers/omni.controller.ts'),
    );
    const open = omni?.ungatedHandlers.map((handler) =>
      handler.replace(/ \(line \d+\)$/, ''),
    );

    expect(open).not.toContain('assignAgent');
    expect(open).not.toContain('claimConversation');
    expect(open).not.toContain('unassignAgent');
  });

  it('should not let a handler carry two route or two permission decorators', () => {
    // Doubled decorators mean a neighbouring member lost its own — see the comment
    // in analyzeController. Nest keeps only the last of each, so the extra path is
    // dead and the permission that reads as protecting one route is protecting
    // another. Zero across the codebase today; any new one is this bug.
    const doubled = REPORTS.flatMap((report) =>
      report.doubledDecorators.map((entry) => `${report.file}#${entry}`),
    );
    expect({ doubled }).toEqual({ doubled: [] });
  });

  it('should not leave a method with Nest param decorators unregistered as a route', () => {
    // The other half of the same failure: the member the decorators drifted away
    // from still takes `@Query()`/`@Param()` and still delegates to the service,
    // but Nest never routes to it. It cannot be reached and nothing reports it.
    const orphaned = REPORTS.flatMap((report) =>
      report.orphanedHandlers.map((entry) => `${report.file}#${entry}`),
    );
    expect({ orphaned }).toEqual({ orphaned: [] });
  });

  it('should report the current coverage ratio', () => {
    const total = REPORTS.reduce((sum, r) => sum + r.handlerCount, 0);
    const gated = REPORTS.reduce((sum, r) => sum + r.gatedCount, 0);
    const ratio = gated / total;

    // Ratchet: this may only ever go up. The remainder is the reviewed
    // self-scoped / anonymous set in the two allowlists above.

    console.log(
      `[C-05] route authz coverage: ${gated}/${total} handlers (${(ratio * 100).toFixed(1)}%)`,
    );
    expect(ratio).toBeGreaterThanOrEqual(0.96);
  });
});
