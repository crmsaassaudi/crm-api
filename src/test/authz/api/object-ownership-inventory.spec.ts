/**
 * Which collections treat `ownerId` as an AUTHORIZATION axis, and which merely
 * stamp who touched a row.
 *
 * The distinction matters because it decides whether a record needs
 * record-level authorization at all. Round 2 of the RBAC audit recorded "@UseAcl
 * is missing on N controllers" as a finding; round 3 found that most of those
 * controllers manage tenant-level configuration or stamp `createdBy` for audit
 * only — bolting object-ACL onto them would invent an ownership model rather
 * than enforce one. Meanwhile `dashboards` genuinely was ownership-scoped, and
 * enforced it correctly in its service, so it needed no decorator either.
 *
 * That reasoning is expensive to re-derive and easy to get wrong in either
 * direction, so this test pins it: a new `ownerId` on a schema in the
 * NOT-OWNERSHIP-SCOPED list fails here, which is exactly the moment somebody
 * has to decide whether it is an authorization axis and wire it up.
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

const SRC_ROOT = join(__dirname, '..', '..', '..');

/**
 * `ownerId` IS an authorization axis here. Each entry names where the decision
 * is taken, and the assertions below check that claim rather than trust it.
 */
const OWNERSHIP_AUTHORIZED: Record<
  string,
  { enforcedIn: string; via: 'acl-decorator' | 'service' }
> = {
  'contacts/infrastructure/persistence/document/entities/contact.schema.ts': {
    enforcedIn: 'contacts/contacts.controller.ts',
    via: 'acl-decorator',
  },
  'accounts/infrastructure/persistence/document/entities/account.schema.ts': {
    enforcedIn: 'accounts/accounts.controller.ts',
    via: 'acl-decorator',
  },
  'deals/infrastructure/persistence/document/entities/deal.schema.ts': {
    enforcedIn: 'deals/deals.controller.ts',
    via: 'acl-decorator',
  },
  'tickets/infrastructure/persistence/document/entities/ticket.schema.ts': {
    enforcedIn: 'tickets/tickets.controller.ts',
    via: 'acl-decorator',
  },
  'tasks/infrastructure/persistence/document/entities/task.schema.ts': {
    enforcedIn: 'tasks/tasks.controller.ts',
    via: 'acl-decorator',
  },
  // Owner-or-shared to read, owner-only to write, decided per call in the
  // service. A decorator would be a second, weaker copy of that rule.
  'dashboards/dashboard.schema.ts': {
    enforcedIn: 'dashboards/dashboards.service.ts',
    via: 'service',
  },
};

/**
 * `ownerId` here is NOT an authorization axis, with the reason. Adding one of
 * these to a route's `@UseAcl` would enforce an ownership rule the domain does
 * not have.
 */
const NOT_OWNERSHIP_SCOPED: Record<string, string> = {
  'common/permissions/access-policy.schema.ts':
    'the ABAC policy document itself; `ownerId` here is a policy SUBJECT attribute, not the record owner',
  'reports/contact/rollup/contact-daily-metrics.schema.ts':
    'pre-aggregated rollup keyed BY ownerId so a scoped read can filter on it — the axis is the group-by key, not an access grant',
  'tenants/infrastructure/persistence/document/entities/tenant.schema.ts':
    'tenant owner drives the full-ceiling grant in permission.engine.ts, not per-record access to the tenant document',
};

/**
 * Modules where `createdBy` IS the authorization axis, enforced in the service
 * with a tenant OWNER/ADMIN bypass. Kept separate from OWNERSHIP_AUTHORIZED
 * because the field is different — a reviewer grepping `ownerId` would miss
 * these entirely.
 */
const CREATOR_AUTHORIZED: Record<string, { enforcedIn: string }> = {
  files: {
    // `assertCanManage(folder, userId, userRole)` — creator or OWNER/ADMIN.
    // `userRole` comes from `cls.get('tenantRole')`, written by
    // TenantInterceptor; before that write existed (finding M-15) every role
    // branch here was permanently false and admins were locked out of folders
    // they had not created. The write is asserted below.
    enforcedIn: 'files/folder.service.ts',
  },
};

/**
 * Collections that stamp `createdBy` for the audit trail and deliberately do
 * NOT authorize on it. Verified: no service in these modules compares
 * `createdBy` against the caller.
 */
const AUDIT_STAMP_ONLY: Record<string, string> = {
  notes: 'a note is authorized through the record it hangs off',
  'social-posts':
    'publication instances belong to a channel and a schedule, not to a person',
  'ai-video': 'a render job belongs to the tenant; createdBy is provenance',
};

function walk(dir: string, suffix: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, suffix, found);
    else if (entry.endsWith(suffix) && !entry.includes('.spec.'))
      found.push(full);
  }
  return found;
}

const SCHEMAS_WITH_OWNER_ID = walk(SRC_ROOT, '.schema.ts')
  .filter((file) => /\bownerId\b/.test(readFileSync(file, 'utf8')))
  .map((file) => relative(SRC_ROOT, file).replace(/\\/g, '/'))
  .sort();

describe('object-ownership inventory', () => {
  it('should account for every schema carrying an ownerId', () => {
    const accounted = new Set([
      ...Object.keys(OWNERSHIP_AUTHORIZED),
      ...Object.keys(NOT_OWNERSHIP_SCOPED),
    ]);
    const unaccounted = SCHEMAS_WITH_OWNER_ID.filter(
      (file) => !accounted.has(file),
    );
    // A new ownerId is the moment to decide: authorization axis, or bookkeeping?
    // Add it to one of the two lists above, with a reason.
    expect({ unaccounted }).toEqual({ unaccounted: [] });
  });

  it('should keep both lists pointing at schemas that still exist', () => {
    const present = new Set(SCHEMAS_WITH_OWNER_ID);
    const stale = [
      ...Object.keys(OWNERSHIP_AUTHORIZED),
      ...Object.keys(NOT_OWNERSHIP_SCOPED),
    ].filter((file) => !present.has(file));
    expect(stale).toEqual([]);
  });

  it('should prove each ownership-authorized record really enforces it', () => {
    for (const [schema, entry] of Object.entries(OWNERSHIP_AUTHORIZED)) {
      const source = readFileSync(join(SRC_ROOT, entry.enforcedIn), 'utf8');
      const enforces =
        entry.via === 'acl-decorator'
          ? /@UseAcl\s*\(/.test(source) && /@LoadResource\s*\(/.test(source)
          : /ForbiddenException/.test(source);
      // Deleting the enforcement turns this red instead of leaving a comment
      // that says the record is protected.
      expect([schema, enforces]).toEqual([schema, true]);
    }
  });

  it('should keep audit-stamp-only modules free of an ownership comparison', () => {
    // If one of these starts comparing createdBy to the caller, it has become an
    // authorization axis and belongs in OWNERSHIP_AUTHORIZED with a real check —
    // not in a hand-rolled inline comparison nobody audits.
    const violations: string[] = [];
    for (const moduleDir of Object.keys(AUDIT_STAMP_ONLY)) {
      for (const file of walk(join(SRC_ROOT, moduleDir), '.service.ts')) {
        const source = readFileSync(file, 'utf8');
        if (
          /createdBy[^\n]{0,60}!==[^\n]{0,60}(userId|cls\.get)/.test(source) ||
          /(userId|cls\.get\('userId'\))[^\n]{0,60}!==[^\n]{0,40}createdBy/.test(
            source,
          )
        ) {
          violations.push(relative(SRC_ROOT, file).replace(/\\/g, '/'));
        }
      }
    }
    expect({ violations }).toEqual({ violations: [] });
  });

  it('should prove each creator-authorized module enforces it, and that tenantRole is populated', () => {
    for (const [module, entry] of Object.entries(CREATOR_AUTHORIZED)) {
      const source = readFileSync(join(SRC_ROOT, entry.enforcedIn), 'utf8');
      expect([module, /createdBy\s*!==/.test(source)]).toEqual([module, true]);
      expect([module, /ForbiddenException/.test(source)]).toEqual([
        module,
        true,
      ]);
    }

    // The admin-bypass half of the rule reads `cls.get('tenantRole')`. If
    // nothing writes that key the branch is permanently false — fail-closed, but
    // it silently locks tenant admins out of every folder they did not create,
    // which is how M-15 shipped. Assert the writer still exists.
    const interceptor = readFileSync(
      join(SRC_ROOT, 'common/interceptors/tenant.interceptor.ts'),
      'utf8',
    );
    expect(interceptor).toMatch(/set\('tenantRole'/);
  });

  it('should give every exemption a substantive reason', () => {
    for (const [key, reason] of Object.entries({
      ...NOT_OWNERSHIP_SCOPED,
      ...AUDIT_STAMP_ONLY,
    })) {
      expect([key, reason.length > 30]).toEqual([key, true]);
    }
  });
});
