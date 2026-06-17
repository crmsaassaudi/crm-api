import { ClsServiceManager } from 'nestjs-cls';
import { Types } from 'mongoose';

/** Stable default userId for tests (valid ObjectId format) */
const DEFAULT_USER_ID = new Types.ObjectId().toString();

/**
 * Get the real global CLS service used by Mongoose plugins.
 * nestjs-cls creates a singleton backed by AsyncLocalStorage at import time.
 */
export function getGlobalClsService() {
  return ClsServiceManager.getClsService();
}

/**
 * Run a callback within a real CLS context with the given tenant.
 * This simulates what TenantInterceptor + ClsMiddleware do in production.
 *
 * MUST be used for integration tests because the tenant-filter plugin
 * reads CLS via AsyncLocalStorage — which only works inside a CLS run().
 */
export async function runWithTenant<T>(
  tenantId: string,
  callback: () => Promise<T>,
  userId = DEFAULT_USER_ID,
): Promise<T> {
  const cls = getGlobalClsService();
  return new Promise<T>((resolve, reject) => {
    void cls.run(async () => {
      cls.set('tenantId', tenantId);
      cls.set('activeTenantId', tenantId);
      cls.set('userId', userId);
      try {
        const result = await callback();
        resolve(result);
      } catch (err) {
        reject(err);
      }
    });
  });
}

/**
 * Run a callback WITHOUT any CLS context (simulates missing middleware).
 * Used to verify fail-closed behavior.
 */
export async function runWithoutTenant<T>(
  callback: () => Promise<T>,
): Promise<T> {
  const cls = getGlobalClsService();
  return new Promise<T>((resolve, reject) => {
    void cls.run(async () => {
      // Intentionally do NOT set tenantId/activeTenantId
      try {
        const result = await callback();
        resolve(result);
      } catch (err) {
        reject(err);
      }
    });
  });
}
