/**
 * A route that writes TENANT-WIDE CONFIGURATION must not be gated on a
 * per-record permission.
 *
 * This is its own class of bug, and it does not look like one in review: the
 * decorator is present, the test suite is green, the route-coverage gate is
 * satisfied. Two shipped instances:
 *
 *   - every `dashboards` route was gated on `contacts:*`, so `contacts:delete`
 *     deleted anybody's dashboard;
 *   - lead-scoring rule create/update/delete/toggle AND a full-tenant rescore
 *     were gated on `contacts:edit`, which every Sales Rep holds.
 *
 * Both are the same mistake: reaching for the permission of the records a
 * feature happens to touch instead of the permission for changing the
 * workspace. The convention here is `settings:manage_system` for configuration
 * writes, and this test holds the line — a config-writing controller that gates
 * on a record resource fails until it is either fixed or filed below with a
 * reason.
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

const SRC_ROOT = join(__dirname, '..', '..', '..');

/** Per-record resources. Holding one says nothing about administering a tenant. */
const RECORD_RESOURCES = new Set([
  'contacts',
  'leads',
  'accounts',
  'deals',
  'tickets',
  'tasks',
  'dashboards',
  'files',
  'omni_channel',
]);

/**
 * Controllers whose writes are tenant-wide configuration. Each must gate those
 * writes on something other than a record resource.
 */
const CONFIG_CONTROLLERS = [
  'lead-scoring/lead-scoring.controller.ts',
  'custom-fields/custom-fields.controller.ts',
  'list-views/list-views.controller.ts',
  'common/permissions/custom-roles.controller.ts',
  'common/permissions/access-policy.controller.ts',
  'common/permissions/role-assignment.controller.ts',
  'sla-policies/sla-policies.controller.ts',
  'escalation-policies/escalation-policies.controller.ts',
  'automation-rules/automation-workflow.controller.ts',
  'channels/email-settings.controller.ts',
  'tenants/tenant-settings.controller.ts',
  'org-units/org-units.controller.ts',
  'assignment/api/assignment.controller.ts',
];

/**
 * Deliberate exceptions: a config write whose natural permission genuinely IS a
 * record resource. Needs a reason, and adding one is a review.
 */
const REVIEWED_RECORD_GATED_WRITES: Record<string, string> = {
  // A note is authorized through the record it hangs off, so its writes take the
  // parent's permission by design — not a configuration surface at all.
  'notes/notes.controller.ts':
    'a note is a child of a contact/deal/ticket and inherits its parent record permission',
};

const MUTATING_WITH_RESOURCE =
  /@(Post|Put|Patch|Delete)\s*\([^)]*\)[\s\S]{0,400}?@RequirePermission(?:s)?\(\s*'([a-z_]+)'\s*,\s*'([a-z_]+)'/g;

/** Every (action, resource) pair attached to a mutating handler in `file`. */
function mutatingGates(file: string): { action: string; resource: string }[] {
  const source = readFileSync(join(SRC_ROOT, file), 'utf8');
  const gates: { action: string; resource: string }[] = [];
  MUTATING_WITH_RESOURCE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MUTATING_WITH_RESOURCE.exec(source))) {
    gates.push({ action: match[2], resource: match[3] });
  }
  return gates;
}

function findControllers(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) findControllers(full, found);
    else if (entry.endsWith('.controller.ts') && !entry.includes('.spec.'))
      found.push(full);
  }
  return found;
}

describe('configuration writes are not gated on record permissions', () => {
  it('should keep the config-controller list pointing at files that still exist', () => {
    const present = new Set(
      findControllers(SRC_ROOT).map((file) =>
        relative(SRC_ROOT, file).replace(/\\/g, '/'),
      ),
    );
    const stale = [
      ...CONFIG_CONTROLLERS,
      ...Object.keys(REVIEWED_RECORD_GATED_WRITES),
    ].filter((file) => !present.has(file));
    expect(stale).toEqual([]);
  });

  it('should let no configuration write be gated on a per-record resource', () => {
    const violations: string[] = [];
    for (const file of CONFIG_CONTROLLERS) {
      if (file in REVIEWED_RECORD_GATED_WRITES) continue;
      for (const gate of mutatingGates(file)) {
        if (RECORD_RESOURCES.has(gate.resource)) {
          violations.push(`${file} → ${gate.action}:${gate.resource}`);
        }
      }
    }
    // Fix the decorator, or file the controller in
    // REVIEWED_RECORD_GATED_WRITES with a reason.
    expect({ violations }).toEqual({ violations: [] });
  });

  it('should confirm lead-scoring rule writes and the tenant-wide rescore need settings:manage_system', () => {
    // Called out by name because this one was reachable by the lowest standard
    // role: every Sales Rep template carries `contacts:edit`.
    const gates = mutatingGates('lead-scoring/lead-scoring.controller.ts');
    expect(gates.length).toBeGreaterThanOrEqual(5);
    for (const gate of gates) {
      expect([gate, `${gate.action}:${gate.resource}`]).toEqual([
        gate,
        'manage_system:settings',
      ]);
    }
  });

  it('should keep every dashboards route on the dashboards resource', () => {
    const source = readFileSync(
      join(SRC_ROOT, 'dashboards/dashboards.controller.ts'),
      'utf8',
    );
    const resources = [
      ...source.matchAll(/@RequirePermission\(\s*'[a-z_]+'\s*,\s*'([a-z_]+)'/g),
    ].map((match) => match[1]);
    expect(resources.length).toBeGreaterThanOrEqual(6);
    expect([...new Set(resources)]).toEqual(['dashboards']);
  });

  it('should give every exception a substantive reason', () => {
    for (const [file, reason] of Object.entries(REVIEWED_RECORD_GATED_WRITES)) {
      expect([file, reason.length > 30]).toEqual([file, true]);
    }
  });
});
