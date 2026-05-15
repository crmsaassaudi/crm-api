import { SetMetadata } from '@nestjs/common';
import { PermissionAction, PermissionResource } from './permission.constants';

export const PERMISSION_RULE_METADATA = 'permissionRule';

export interface PermissionRuleMetadata {
  action: PermissionAction;
  resource: PermissionResource;
}

export const RequirePermission = (
  action: PermissionAction,
  resource: PermissionResource,
) => SetMetadata(PERMISSION_RULE_METADATA, { action, resource });
