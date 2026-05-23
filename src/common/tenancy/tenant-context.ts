import { ClsService } from 'nestjs-cls';

/**
 * Sets up tenant CLS context for non-processor background work
 * (event listeners, cron jobs, one-off scripts).
 *
 * **For BullMQ processors, use `BaseTenantConsumer` instead.**
 * Do NOT call this function directly inside processors — the base
 * class handles CLS setup automatically in its `process()` method.
 */
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
