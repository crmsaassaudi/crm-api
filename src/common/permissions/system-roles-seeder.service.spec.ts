import { SystemRolesSeederService } from './system-roles-seeder.service';
import {
  SYSTEM_ROLE_TEMPLATES,
  resolveTemplatePermissions,
} from './system-role-templates';
import { CORE_PERMISSIONS } from './permission.constants';

/**
 * The seeder is the reason a brand-new tenant is never role-less, and the reason
 * a template version bump can be rolled out centrally. Both properties are only
 * safe if it is strictly idempotent, so that is what these cover.
 */
describe('SystemRolesSeederService', () => {
  const tenantId = 'tenant_1';

  let rows: any[];
  let model: any;
  let moduleRef: any;
  let eventEmitter: any;
  let tenant: any;
  let service: SystemRolesSeederService;

  const makeRow = (data: any) => ({
    ...data,
    set(patch: any) {
      Object.assign(this, patch);
    },
    save: jest.fn().mockResolvedValue(undefined),
  });

  beforeEach(() => {
    rows = [];
    tenant = { id: tenantId, availablePermissions: null };
    model = {
      find: jest.fn(() => ({ exec: () => Promise.resolve(rows) })),
      exists: jest.fn(() => ({ exec: () => Promise.resolve(null) })),
      create: jest.fn((doc: any) => {
        rows.push(makeRow(doc));
        return Promise.resolve(doc);
      }),
    };
    moduleRef = {
      get: () => ({ findById: jest.fn().mockResolvedValue(tenant) }),
    };
    eventEmitter = { emit: jest.fn() };
    service = new SystemRolesSeederService(model, moduleRef, eventEmitter);
  });

  const nonGated = SYSTEM_ROLE_TEMPLATES.filter((t) => !t.requiresFeature);

  it('should materialise every non-gated template for a fresh tenant', async () => {
    const result = await service.ensureForTenant(tenantId);

    expect(result.created).toEqual(nonGated.map((t) => t.systemKey));
    expect(model.create).toHaveBeenCalledTimes(nonGated.length);
    expect(eventEmitter.emit).toHaveBeenCalledWith(
      'tenant.permissions.updated',
      {
        tenantId,
      },
    );

    const created = model.create.mock.calls.map((c: any[]) => c[0]);
    expect(created.every((r: any) => r.isSystem)).toBe(true);
    expect(created.every((r: any) => typeof r.systemKey === 'string')).toBe(
      true,
    );
  });

  it('should be idempotent — a second run creates and changes nothing', async () => {
    await service.ensureForTenant(tenantId);
    model.create.mockClear();
    eventEmitter.emit.mockClear();

    const result = await service.ensureForTenant(tenantId);

    expect(result.created).toEqual([]);
    expect(result.updated).toEqual([]);
    expect(result.unchanged).toEqual(nonGated.map((t) => t.systemKey));
    expect(model.create).not.toHaveBeenCalled();
    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });

  it('should re-sync a row left behind by an older template version', async () => {
    const template = nonGated[0];
    rows.push(
      makeRow({
        tenantId,
        systemKey: template.systemKey,
        templateVersion: template.version - 1,
        isSystem: true,
        name: template.name,
        permissions: ['leads:view'],
      }),
    );

    const result = await service.ensureForTenant(tenantId);

    expect(result.updated).toContain(template.systemKey);
    const row = rows[0];
    expect(row.templateVersion).toBe(template.version);
    expect(row.permissions).toEqual(
      resolveTemplatePermissions(template, new Set(CORE_PERMISSIONS)),
    );
  });

  it('should skip a feature-gated template until the tenant is entitled', async () => {
    const gated = SYSTEM_ROLE_TEMPLATES.find((t) => t.requiresFeature);
    if (!gated) return; // no gated template configured

    let result = await service.ensureForTenant(tenantId);
    expect(result.skipped).toContain(gated.systemKey);

    rows = [];
    tenant.availablePermissions = [gated.requiresFeature];
    result = await service.ensureForTenant(tenantId);
    expect(result.created).toContain(gated.systemKey);
  });

  it('should suffix the name when a tenant-authored role already owns it', async () => {
    model.exists = jest.fn(() => ({
      exec: () => Promise.resolve({ _id: 'x' }),
    }));

    await service.ensureForTenant(tenantId);

    const created = model.create.mock.calls.map((c: any[]) => c[0]);
    expect(created.every((r: any) => r.name.endsWith(' (System)'))).toBe(true);
  });

  it('should never grant a key outside the tenant ceiling', async () => {
    tenant.disabledCorePermissions = ['leads:view'];

    await service.ensureForTenant(tenantId);

    const granted = model.create.mock.calls.flatMap(
      (c: any[]) => c[0].permissions as string[],
    );
    expect(granted).not.toContain('leads:view');
  });
});
