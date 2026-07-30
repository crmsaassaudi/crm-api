import {
  SYSTEM_ROLE_TEMPLATES,
  SYSTEM_ROLE_KEYS,
  resolveTemplatePermissions,
} from './system-role-templates';
import { ALL_PERMISSIONS, CORE_PERMISSIONS } from './permission.constants';

/**
 * Guards for the built-in role catalogue.
 *
 * The failure these prevent is silent: the engine drops any permission key that
 * is not in the tenant's ceiling, so a typo'd or retired key in a template
 * produces a role that looks correct in the admin UI and grants less than it
 * claims. Nothing at runtime reports it.
 */
describe('SYSTEM_ROLE_TEMPLATES', () => {
  const known = new Set(ALL_PERMISSIONS);

  it('should only reference permissions that exist in the registry', () => {
    const unknown = SYSTEM_ROLE_TEMPLATES.flatMap((template) =>
      (template.permissions ?? [])
        .filter((key) => !known.has(key))
        .map((key) => `${template.systemKey} → ${key}`),
    );
    expect(unknown).toEqual([]);
  });

  it('should gate every template on a permission that exists', () => {
    const unknown = SYSTEM_ROLE_TEMPLATES.filter(
      (template) =>
        template.requiresFeature && !known.has(template.requiresFeature),
    ).map((template) => template.systemKey);
    expect(unknown).toEqual([]);
  });

  it('should keep systemKeys unique', () => {
    expect(new Set(SYSTEM_ROLE_KEYS).size).toBe(SYSTEM_ROLE_KEYS.length);
  });

  describe('PII unmask grants', () => {
    const byKey = (key: string) =>
      SYSTEM_ROLE_TEMPLATES.find((t) => t.systemKey === key)!;

    // FIELD_SENSITIVITY masks contact emails and phones unless the principal holds
    // `contacts:unmask`. For a long time NO template granted it — which did not show,
    // because the registry declared the fields as `email`/`phone` while contacts
    // serialise `emails`/`phones`, so the interceptor matched nothing. Fixing that
    // typo made the control live; without these grants every non-administrator would
    // see `a****@acme.com` with no way to reveal it.
    it.each(['sys.manager', 'sys.sales_rep', 'sys.support_agent'])(
      'should grant contacts:unmask to %s, whose job is to reach the customer',
      (key) => {
        expect(byKey(key).permissions).toContain('contacts:unmask');
      },
    );

    it.each(['sys.read_only', 'sys.auditor', 'sys.marketing'])(
      'should NOT grant contacts:unmask to %s',
      (key) => {
        // Read-only, audit and marketing roles have no reason to see raw PII, and an
        // auditor seeing it would defeat the point of auditing access to it.
        expect(byKey(key).permissions).not.toContain('contacts:unmask');
      },
    );

    it.each(['sys.manager', 'sys.support_agent'])(
      'should grant omni_channel:unmask to %s, who work the inbox',
      (key) => {
        // Granting this preserves exactly what these roles see today. What changes is
        // that Read Only / Auditor / Marketing stop seeing raw customer PII.
        expect(byKey(key).permissions).toContain('omni_channel:unmask');
      },
    );

    it.each(['sys.read_only', 'sys.auditor', 'sys.marketing'])(
      'should NOT grant omni_channel:unmask to %s',
      (key) => {
        expect(byKey(key).permissions).not.toContain('omni_channel:unmask');
      },
    );

    it('should keep at least one role able to unmask', () => {
      // A masking control nobody can lift is a control that breaks the product.
      const canUnmask = SYSTEM_ROLE_TEMPLATES.filter((t) =>
        t.permissions.includes('contacts:unmask'),
      );
      expect(canUnmask.length).toBeGreaterThan(0);
    });
  });

  describe('sys.auditor', () => {
    const auditor = SYSTEM_ROLE_TEMPLATES.find(
      (template) => template.systemKey === 'sys.auditor',
    )!;

    it('should be gated on all_data:view', () => {
      // Ungated, tenants without the feature would see an "Auditor" role whose
      // defining permission is stripped by the engine — a role that reads like
      // a bug rather than an unavailable plan feature.
      expect(auditor.requiresFeature).toBe('all_data:view');
    });

    it('should grant no write permission at all', () => {
      // An auditor who can change what they audit is not an auditor.
      const writes = auditor.permissions.filter((key) =>
        /:(create|edit|delete|assign|import|launch|approve|publish|resolve|move_stage|manage_\w+)$/.test(
          key,
        ),
      );
      expect(writes).toEqual([]);
    });

    it('should not depend on any other feature-gated permission', () => {
      // Its own gate is `all_data:view`; anything else feature-gated in the list
      // would be dropped for tenants that lack it, making the role's breadth
      // depend on unrelated plan flags.
      const core = new Set(CORE_PERMISSIONS);
      const extras = auditor.permissions.filter(
        (key) => key !== 'all_data:view' && !core.has(key),
      );
      expect(extras).toEqual([]);
    });
  });

  describe('resolveTemplatePermissions', () => {
    it('should drop keys outside the tenant ceiling', () => {
      const template = SYSTEM_ROLE_TEMPLATES.find(
        (row) => row.systemKey === 'sys.auditor',
      )!;
      const ceiling = new Set(['all_data:view', 'contacts:view']);

      expect(resolveTemplatePermissions(template, ceiling).sort()).toEqual([
        'all_data:view',
        'contacts:view',
      ]);
    });
  });
});
