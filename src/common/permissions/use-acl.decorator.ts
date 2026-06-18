import { SetMetadata } from '@nestjs/common';
import type {
  PermissionAction,
  PermissionResource,
} from './permission.constants';

export const ACL_METADATA_KEY = 'acl_check';

export interface AclMetadata {
  action: PermissionAction;
  resource: PermissionResource;
  /** Param name in the route that holds the resource ID (default: 'id') */
  idParam?: string;
}

/**
 * @UseAcl decorator — marks a route handler for object-level ACL checks.
 *
 * Usage:
 *   @UseGuards(HybridAuthGuard, AclGuard)
 *   @UseAcl('edit', 'deals')
 *   async updateDeal(@Param('id') id: string) { ... }
 *
 * Resolution logic (in AclGuard):
 *   1. Extract resourceId from route param (default: 'id').
 *   2. Call ObjectAclService.can(userId, action, resourceType, resourceId).
 *   3. If explicit ACL → use it. If null → fall back to PermissionGuard semantics.
 */
export const UseAcl = (
  action: PermissionAction,
  resource: PermissionResource,
  idParam = 'id',
): MethodDecorator =>
  SetMetadata(ACL_METADATA_KEY, {
    action,
    resource,
    idParam,
  } satisfies AclMetadata);
