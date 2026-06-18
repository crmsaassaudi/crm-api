import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ObjectAclService } from './object-acl.service';
import { ACL_METADATA_KEY, type AclMetadata } from './use-acl.decorator';

/**
 * AclGuard — object-level access control guard.
 *
 * Reads @UseAcl metadata and checks ObjectAclService for per-record access.
 * Falls back gracefully when no ACL entry exists (resource-level guards still apply).
 *
 * Registration pattern (in module / controller):
 *   @UseGuards(HybridAuthGuard, PermissionGuard, AclGuard)
 *
 * Note: AclGuard must run AFTER authentication guards so `req.user` is available.
 */
@Injectable()
export class AclGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly aclService: ObjectAclService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const meta = this.reflector.getAllAndOverride<AclMetadata | undefined>(
      ACL_METADATA_KEY,
      [context.getHandler(), context.getClass()],
    );

    // No @UseAcl decorator — guard is a no-op (pass through)
    if (!meta) return true;

    const req = context.switchToHttp().getRequest();
    const user = req.user;
    if (!user) throw new ForbiddenException('Unauthenticated');

    const tenantId: string = user.tenantId ?? req.headers['x-tenant-id'];
    const userId: string = user.id ?? user.sub;
    const resourceId: string = req.params[meta.idParam ?? 'id'];
    const groupIds: string[] = user.groupIds ?? [];

    if (!resourceId) return true; // no resource ID → skip ACL (e.g. list endpoints)

    const result = await this.aclService.can(
      tenantId,
      userId,
      meta.action,
      meta.resource,
      resourceId,
      groupIds,
    );

    // null → no explicit ACL, allow (resource-level guard already ran)
    if (result === null) return true;

    if (result === false) {
      throw new ForbiddenException(
        `Access denied: insufficient permissions for ${meta.action} on ${meta.resource}/${resourceId}`,
      );
    }

    return true;
  }
}
