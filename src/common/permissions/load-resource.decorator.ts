import { SetMetadata } from '@nestjs/common';

export const LOAD_RESOURCE_METADATA_KEY = 'authz:load-resource';

/**
 * Declares which resource loader hydrates the target record before a
 * record-level authorization decision — the Policy Information Point.
 *
 * Record-level authorization is impossible without the record: an ABAC
 * condition on `resource.ownerId` cannot evaluate against `{ id }`. Before
 * this existed, every `resource.*` policy was structurally incapable of
 * matching, which made the entire attribute layer inert (C-01).
 *
 * Usage:
 *
 *   @Patch(':id')
 *   @RequirePermission('edit', 'deals')   // resource-level RBAC
 *   @UseAcl('edit', 'deals')              // record-level ACL + ABAC
 *   @LoadResource('deals')                // hydrate the record for ABAC
 *   update(@Param('id') id: string, ...) {}
 *
 * The key must be registered in ResourceLoaderRegistry.
 */
export const LoadResource = (loaderKey: string) =>
  SetMetadata(LOAD_RESOURCE_METADATA_KEY, loaderKey);
