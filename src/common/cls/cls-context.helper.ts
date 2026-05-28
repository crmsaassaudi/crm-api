import { ClsService } from 'nestjs-cls';

/**
 * Standardized accessors for the CLS store.
 *
 * Codebase has 20+ duplicated reads like
 *   `cls.get('activeTenantId') || cls.get('tenantId')`
 * which makes it easy for one site to drift (e.g. forget the fallback).
 * These helpers centralize the lookup so all callers share one definition.
 *
 * Use them in services + repositories where direct DI of ClsService is
 * already happening — don't introduce new injection chains just to call
 * these.
 */

export function getTenantId(cls: ClsService): string | undefined {
  return (
    cls.get<string>('activeTenantId') || cls.get<string>('tenantId') || undefined
  );
}

export function requireTenantId(cls: ClsService, source: string): string {
  const id = getTenantId(cls);
  if (!id) {
    throw new Error(
      `${source}: missing tenant context — refusing to query without an activeTenantId in CLS`,
    );
  }
  return id;
}

export function getUserId(cls: ClsService): string | undefined {
  return (
    cls.get<string>('userId') || cls.get<any>('user.id') || undefined
  );
}

export function getCorrelationId(cls: ClsService): string | undefined {
  return cls.get<string>('correlationId') || cls.getId?.() || undefined;
}
