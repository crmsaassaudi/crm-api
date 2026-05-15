import {
  CallHandler,
  ExecutionContext,
  InternalServerErrorException,
} from '@nestjs/common';
import { lastValueFrom, of } from 'rxjs';
import { DataVisibilityInterceptor } from './data-visibility.interceptor';
import { TenantRoleEnum } from '../roles/tenant-role.enum';

describe('DataVisibilityInterceptor', () => {
  let cls: {
    get: jest.Mock;
    set: jest.Mock;
  };
  let hierarchyService: {
    getVisibleOwnerIds: jest.Mock;
  };
  let settingsService: {
    getSetting: jest.Mock;
  };
  let moduleRef: {
    get: jest.Mock;
  };
  let interceptor: DataVisibilityInterceptor;

  beforeEach(() => {
    cls = {
      get: jest.fn((key: string) => {
        const values: Record<string, string> = {
          tenantId: 'tenant_1',
          userId: '507f1f77bcf86cd799439011',
        };
        return values[key];
      }),
      set: jest.fn(),
    };
    hierarchyService = {
      getVisibleOwnerIds: jest
        .fn()
        .mockResolvedValue(['507f1f77bcf86cd799439011']),
    };
    settingsService = {
      getSetting: jest.fn().mockResolvedValue({ defaultAccess: 'private' }),
    };
    moduleRef = {
      get: jest.fn().mockReturnValue({
        findById: jest.fn().mockResolvedValue({
          tenants: [{ tenantId: 'tenant_1', roles: [TenantRoleEnum.MEMBER] }],
        }),
      }),
    };

    interceptor = new DataVisibilityInterceptor(
      cls as any,
      hierarchyService as any,
      settingsService as any,
      moduleRef as any,
    );
  });

  it('should fail closed when visibility resolution fails', async () => {
    settingsService.getSetting.mockRejectedValueOnce(new Error('db timeout'));

    await expect(
      lastValueFrom(interceptor.intercept(createContext(), createHandler())),
    ).rejects.toBeInstanceOf(InternalServerErrorException);

    expect(cls.set).toHaveBeenCalledWith('visibleOwnerIds', []);
  });

  it('should keep admin bypass explicit', async () => {
    moduleRef.get.mockReturnValue({
      findById: jest.fn().mockResolvedValue({
        tenants: [{ tenantId: 'tenant_1', roles: [TenantRoleEnum.ADMIN] }],
      }),
    });

    await expect(
      lastValueFrom(interceptor.intercept(createContext(), createHandler())),
    ).resolves.toEqual({ ok: true });

    expect(cls.set).toHaveBeenCalledWith('visibleOwnerIds', null);
    expect(hierarchyService.getVisibleOwnerIds).not.toHaveBeenCalled();
  });

  function createContext(): ExecutionContext {
    return {} as ExecutionContext;
  }

  function createHandler(): CallHandler {
    return {
      handle: jest.fn(() => of({ ok: true })),
    };
  }
});
