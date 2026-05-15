import { ClsService } from 'nestjs-cls';

export function runWithTenantContext<T>(
  cls: ClsService,
  tenantId: string,
  callback: () => T,
): T {
  if (!tenantId) {
    throw new Error('Missing tenantId for tenant-scoped background execution');
  }

  return cls.runWith(
    {
      tenantId,
      activeTenantId: tenantId,
    } as any,
    callback,
  );
}
