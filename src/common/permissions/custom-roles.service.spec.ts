/**
 * CustomRolesService — the anti-escalation invariant on BOTH axes a role grants.
 *
 * A custom role carries two things, and each is a privilege grant:
 *   - `permissions`, guarded since C-04;
 *   - `dataScope`, guarded here (H-07).
 *
 * The second is easy to miss because widening it escalates *without adding a
 * single permission key*. An ORG_UNIT-scoped manager who holds `roles:create`
 * can otherwise mint "Sales Rep (tenant scope)", assign it to themselves, and
 * read the entire workspace while every key stays inside what they already held.
 * A guard that inspects only `permissions` waves that through.
 *
 * Direction matters as much as presence: narrowing a scope is de-escalation and
 * must stay unguarded, exactly as removing a permission key is. A guard that
 * blocks both directions is a different bug — it makes roles un-tightenable by
 * anyone but an owner.
 */

import { ForbiddenException } from '@nestjs/common';
import { CustomRolesService } from './custom-roles.service';
import { DataScope } from './data-scope.enum';

const TENANT = 'tenant_1';
const CALLER = 'user_caller';

describe('CustomRolesService — data scope grants', () => {
  let service: CustomRolesService;
  let model: any;
  let authzCache: any;
  let cls: any;
  let saved: any;

  /** A hydrated-document stand-in for an existing, editable role. */
  const existingRole = (overrides: Record<string, unknown> = {}) => {
    const doc: any = {
      _id: 'role_1',
      tenantId: TENANT,
      name: 'Sales Rep',
      description: '',
      permissions: ['contacts:view'],
      dataScope: DataScope.ORG_UNIT,
      isSystem: false,
      color: '#6366f1',
      ...overrides,
    };
    doc.save = jest.fn().mockImplementation(() => {
      saved = { ...doc };
      return Promise.resolve(doc);
    });
    return doc;
  };

  beforeEach(() => {
    saved = undefined;

    // `new this.model(...)` for create, `this.model.findOne(...)` for update.
    const Model: any = jest.fn().mockImplementation((data: any) => {
      const doc = { ...data, _id: 'role_new' };
      doc.save = jest.fn().mockImplementation(() => {
        saved = { ...doc };
        return Promise.resolve(doc);
      });
      return doc;
    });
    Model.findOne = jest.fn();
    Model.find = jest.fn().mockReturnValue({
      sort: jest.fn().mockReturnValue({
        lean: jest
          .fn()
          .mockReturnValue({ exec: jest.fn().mockResolvedValue([]) }),
      }),
    });
    model = Model;

    authzCache = {
      // Caller holds every permission key so the C-04 guard never fires and the
      // scope guard is what these tests actually exercise.
      explainForUser: jest.fn().mockResolvedValue({
        effective: [],
        sources: {},
        tenantCeiling: [],
        fullAccess: true,
        fullAccessReason: 'admin',
      }),
      resolveDataScope: jest
        .fn()
        .mockResolvedValue({ scope: DataScope.ORG_UNIT, orgUnitId: 'unit_b' }),
    };

    cls = { get: jest.fn().mockReturnValue(CALLER) };

    service = new CustomRolesService(
      model,
      { emit: jest.fn() } as any,
      { record: jest.fn().mockResolvedValue(undefined) } as any,
      { get: jest.fn().mockReturnValue(authzCache) } as any,
      cls as any,
    );
  });

  describe('create', () => {
    it('should allow a scope equal to the caller own', async () => {
      await service.create(TENANT, {
        name: 'Peer',
        dataScope: DataScope.ORG_UNIT,
      });
      expect(saved.dataScope).toBe(DataScope.ORG_UNIT);
    });

    it('should allow a scope narrower than the caller own', async () => {
      await service.create(TENANT, {
        name: 'Junior',
        dataScope: DataScope.SELF,
      });
      expect(saved.dataScope).toBe(DataScope.SELF);
    });

    it('should REFUSE a scope wider than the caller own', async () => {
      await expect(
        service.create(TENANT, {
          name: 'Escalated',
          dataScope: DataScope.TENANT,
        }),
      ).rejects.toThrow(ForbiddenException);
      expect(saved).toBeUndefined();
    });

    it('should REFUSE the adjacent widening step, not just the extreme one', async () => {
      // ORG_UNIT → ORG_UNIT_SUBTREE is one rung. A guard that only catches
      // TENANT lets a manager climb the tree a level at a time.
      await expect(
        service.create(TENANT, {
          name: 'OneRungUp',
          dataScope: DataScope.ORG_UNIT_SUBTREE,
        }),
      ).rejects.toThrow(/your own scope is "org_unit"/);
    });

    it('should persist null when no scope is requested, not a default', async () => {
      // Null means "no opinion" and defers to the tenant default. Defaulting to
      // anything else here would make every new role assert a scope its author
      // never chose.
      await service.create(TENANT, { name: 'Unopinionated' });
      expect(saved.dataScope).toBeNull();
      expect(authzCache.resolveDataScope).not.toHaveBeenCalled();
    });

    it('should let a TENANT-scoped caller grant any scope', async () => {
      authzCache.resolveDataScope.mockResolvedValue({
        scope: DataScope.TENANT,
        orgUnitId: null,
      });
      await service.create(TENANT, {
        name: 'Wide',
        dataScope: DataScope.TENANT,
      });
      expect(saved.dataScope).toBe(DataScope.TENANT);
    });

    it('should REFUSE when the acting principal cannot be resolved', async () => {
      // Fail-closed. An unattributable grant is exactly the one that must not
      // proceed, since the audit log would name nobody.
      cls.get.mockReturnValue(undefined);
      await expect(
        service.create(TENANT, { name: 'X', dataScope: DataScope.TENANT }),
      ).rejects.toThrow(/Cannot resolve the acting principal/);
    });
  });

  describe('update', () => {
    const arrangeExisting = (dataScope: DataScope | null) => {
      const doc = existingRole({ dataScope });
      model.findOne.mockReturnValue({
        exec: jest.fn().mockResolvedValue(doc),
      });
      return doc;
    };

    it('should allow NARROWING a role scope without checking the caller ceiling', async () => {
      // De-escalation. Requiring ORG_UNIT_SUBTREE authority to *reduce* a role
      // to ORG_UNIT would leave over-broad roles un-tightenable.
      arrangeExisting(DataScope.ORG_UNIT_SUBTREE);
      await service.update('role_1', TENANT, { dataScope: DataScope.SELF });
      expect(saved.dataScope).toBe(DataScope.SELF);
      expect(authzCache.resolveDataScope).not.toHaveBeenCalled();
    });

    it('should REFUSE widening a role scope beyond the caller own', async () => {
      arrangeExisting(DataScope.SELF);
      await expect(
        service.update('role_1', TENANT, { dataScope: DataScope.TENANT }),
      ).rejects.toThrow(/cannot grant data scope "tenant"/);
    });

    it('should allow widening up to the caller own scope', async () => {
      arrangeExisting(DataScope.SELF);
      await service.update('role_1', TENANT, {
        dataScope: DataScope.ORG_UNIT,
      });
      expect(saved.dataScope).toBe(DataScope.ORG_UNIT);
    });

    it('should treat an unchanged scope as a no-op, not a grant', async () => {
      arrangeExisting(DataScope.ORG_UNIT);
      await service.update('role_1', TENANT, {
        dataScope: DataScope.ORG_UNIT,
        name: 'Renamed',
      });
      expect(authzCache.resolveDataScope).not.toHaveBeenCalled();
    });

    it('should guard a scope set for the FIRST time on a role that had none', async () => {
      // current = null is not "already TENANT" — going from no opinion to an
      // explicit wide scope is a widening and must be checked.
      arrangeExisting(null);
      await expect(
        service.update('role_1', TENANT, { dataScope: DataScope.TENANT }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should NOT invoke the scope guard when dataScope is absent from the patch', async () => {
      arrangeExisting(DataScope.ORG_UNIT_SUBTREE);
      await service.update('role_1', TENANT, { name: 'Renamed' });
      expect(authzCache.resolveDataScope).not.toHaveBeenCalled();
      expect(saved.dataScope).toBe(DataScope.ORG_UNIT_SUBTREE);
    });

    it('should REFUSE editing a system role regardless of scope', async () => {
      const doc = existingRole({ isSystem: true });
      model.findOne.mockReturnValue({
        exec: jest.fn().mockResolvedValue(doc),
      });
      await expect(
        service.update('role_1', TENANT, { dataScope: DataScope.SELF }),
      ).rejects.toThrow(/System roles cannot be edited/);
    });
  });
});
