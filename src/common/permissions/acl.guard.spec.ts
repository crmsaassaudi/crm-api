import {
  ExecutionContext,
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { ACL_METADATA_KEY } from './use-acl.decorator';
import { LOAD_RESOURCE_METADATA_KEY } from './load-resource.decorator';
import { AclGuard } from './acl.guard';

describe('AclGuard fail-closed record enforcement', () => {
  const request = {
    params: { id: 'record-1' },
    user: { id: 'user-1' },
  };
  const context = {
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;

  const build = (options?: {
    loaderKey?: string | null;
    record?: Record<string, unknown>;
    allowed?: boolean;
  }) => {
    const meta = { action: 'view', resource: 'contacts', idParam: 'id' };
    const reflector = {
      getAllAndOverride: jest.fn((key: string) => {
        if (key === ACL_METADATA_KEY) return meta;
        if (key === LOAD_RESOURCE_METADATA_KEY) {
          return options?.loaderKey === null
            ? undefined
            : (options?.loaderKey ?? 'contacts');
        }
        return undefined;
      }),
    };
    const authz = {
      canAccessRecord: jest.fn().mockResolvedValue(options?.allowed ?? true),
    };
    const clsValues: Record<string, unknown> = {
      tenantId: 'tenant-1',
      userId: 'user-1',
      principalType: 'user',
      visibleGroupIds: [],
    };
    const cls = {
      get: jest.fn((key: string) => clsValues[key]),
      set: jest.fn(),
    };
    const loaders = {
      load: jest.fn().mockResolvedValue(options?.record),
    };
    const guard = new AclGuard(
      reflector as any,
      authz as any,
      cls as any,
      loaders as any,
      { get: jest.fn() } as any,
    );
    return { guard, authz, loaders };
  };

  it('should reject an ACL route that omitted its resource loader', async () => {
    const { guard, authz } = build({ loaderKey: null });
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
    expect(authz.canAccessRecord).not.toHaveBeenCalled();
  });

  it('should return 404 when the loader cannot resolve the record', async () => {
    const { guard, authz } = build({ record: undefined });
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(authz.canAccessRecord).not.toHaveBeenCalled();
  });

  it('should pass the hydrated record to the PDP and honor a deny', async () => {
    const record = { _id: 'record-1', ownerId: 'other-user' };
    const { guard, authz } = build({ record, allowed: false });
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(authz.canAccessRecord).toHaveBeenCalledWith(
      expect.objectContaining({ record, resourceId: 'record-1' }),
    );
  });

  it('should allow only after the hydrated PDP decision allows', async () => {
    const { guard } = build({
      record: { _id: 'record-1', ownerId: 'user-1' },
      allowed: true,
    });
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });
});
