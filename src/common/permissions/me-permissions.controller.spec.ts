/**
 * MePermissionsController — the frontend's single source of truth (H-06).
 *
 * The contract worth pinning is narrow but load-bearing: the subject comes from
 * CLS and nowhere else, and every path that cannot produce a real answer produces
 * an empty one rather than a partial or an optimistic one. A wrong value here is
 * not a rendering bug — it decides what an entire UI shows.
 */

import { UnauthorizedException } from '@nestjs/common';
import { MePermissionsController } from './me-permissions.controller';
import { DataScope } from './data-scope.enum';

const USER = '507f1f77bcf86cd799439011';
const TENANT = '507f1f77bcf86cd799439022';

describe('MePermissionsController', () => {
  let controller: MePermissionsController;
  let authzCache: { explainForUser: jest.Mock; resolveDataScope: jest.Mock };
  let clsValues: Record<string, unknown>;

  beforeEach(() => {
    clsValues = {
      userId: USER,
      tenantId: TENANT,
      // Written by DataVisibilityInterceptor before the handler runs.
      visibleGroupIds: ['group_a'],
    };

    authzCache = {
      explainForUser: jest.fn().mockResolvedValue({
        effective: ['contacts:view', 'deals:view'],
        sources: {},
        tenantCeiling: ['contacts:view', 'contacts:edit', 'deals:view'],
        fullAccess: false,
      }),
      resolveDataScope: jest.fn().mockResolvedValue({
        scope: DataScope.ORG_UNIT,
        orgUnitId: 'unit_b',
      }),
    };

    controller = new MePermissionsController(
      authzCache as any,
      {
        get: (key: string) => clsValues[key],
      } as any,
    );
  });

  it('should return the effective set, the ceiling and the scope', async () => {
    const result = await controller.myPermissions();

    expect(result).toEqual({
      userId: USER,
      tenantId: TENANT,
      permissions: ['contacts:view', 'deals:view'],
      tenantCeiling: ['contacts:view', 'contacts:edit', 'deals:view'],
      fullAccess: false,
      fullAccessReason: undefined,
      dataScope: DataScope.ORG_UNIT,
      orgUnitId: 'unit_b',
      groupIds: ['group_a'],
    });
  });

  it('should resolve the subject from CLS, never from an argument', async () => {
    // The handler takes no parameters at all — that is the security property, not
    // an implementation detail. There is no id to tamper with.
    expect(controller.myPermissions).toHaveLength(0);

    await controller.myPermissions();

    expect(authzCache.explainForUser).toHaveBeenCalledWith(USER, TENANT);
    expect(authzCache.resolveDataScope).toHaveBeenCalledWith(USER, TENANT);
  });

  it('should REJECT an unauthenticated request rather than return an empty set', async () => {
    // An empty 200 would render a logged-in shell with everything hidden and no
    // explanation. A 401 lets the client re-authenticate instead.
    delete clsValues.userId;
    await expect(controller.myPermissions()).rejects.toThrow(
      UnauthorizedException,
    );
    expect(authzCache.explainForUser).not.toHaveBeenCalled();
  });

  it('should report tenantId null with an empty set when no workspace is active', async () => {
    // Legitimate mid-onboarding state. Distinguishable from "workspace selected,
    // nothing granted" so the client can explain itself; the two need different
    // UI and conflating them is how a blank app with no message happens.
    delete clsValues.tenantId;

    const result = await controller.myPermissions();

    expect(result.tenantId).toBeNull();
    expect(result.permissions).toEqual([]);
    expect(result.tenantCeiling).toEqual([]);
    expect(result.fullAccess).toBe(false);
    expect(result.dataScope).toBe(DataScope.SELF);
    expect(authzCache.explainForUser).not.toHaveBeenCalled();
  });

  it('should pass through fullAccess and its reason for an admin', async () => {
    authzCache.explainForUser.mockResolvedValue({
      effective: ['contacts:view', 'contacts:edit'],
      sources: {},
      tenantCeiling: ['contacts:view', 'contacts:edit'],
      fullAccess: true,
      fullAccessReason: 'admin',
    });
    authzCache.resolveDataScope.mockResolvedValue({
      scope: DataScope.TENANT,
      orgUnitId: null,
    });

    const result = await controller.myPermissions();

    expect(result.fullAccess).toBe(true);
    expect(result.fullAccessReason).toBe('admin');
    // `effective` already equals the ceiling under fullAccess, so the controller
    // needs no owner/admin branch — asserted so nobody adds one back.
    expect(result.permissions).toEqual(result.tenantCeiling);
  });

  it('should PROPAGATE a resolution failure instead of returning an empty set', async () => {
    // Silently returning [] on error would look to the client exactly like "you
    // have no permissions", and it would cache that. A rejection surfaces as an
    // error state the UI can name.
    authzCache.explainForUser.mockRejectedValue(new Error('mongo down'));
    await expect(controller.myPermissions()).rejects.toThrow('mongo down');
  });

  it('should return the empty set for a principal the engine grants nothing', async () => {
    // Deactivated users and role-less members both land here. A real, cacheable
    // answer — not an error.
    authzCache.explainForUser.mockResolvedValue({
      effective: [],
      sources: {},
      tenantCeiling: ['contacts:view'],
      fullAccess: false,
    });

    const result = await controller.myPermissions();

    expect(result.permissions).toEqual([]);
    // The ceiling is still reported, so the UI can say "not granted" rather than
    // "not available on your plan".
    expect(result.tenantCeiling).toEqual(['contacts:view']);
  });
});
