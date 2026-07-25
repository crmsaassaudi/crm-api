import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  UnauthorizedException,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import { AuthzPermissionCacheService } from './authz-permission-cache.service';
import { MyPermissionsResponse } from './dto/my-permissions.dto';
import { DataScope } from './data-scope.enum';

/**
 * The caller's own effective permissions — the single authority the frontend
 * renders from (H-06).
 *
 * Why a dedicated self endpoint rather than reusing
 * `GET /users/:id/effective-permissions`: that route requires `users:view`, so
 * the principals who most need their own permission set — ordinary members —
 * cannot read it. Gating self-introspection behind a user-administration
 * permission is what pushed the frontend into recomputing the set locally in the
 * first place, and that local copy silently ignored `roleIds`.
 *
 * Self-scoped by construction: the subject is taken from CLS, never from a path
 * or query parameter, so there is no id to tamper with and no authorization
 * decision to make beyond "is this request authenticated". Returning your own
 * permissions leaks nothing you could not already discover by clicking around.
 */
@ApiTags('Me')
@ApiBearerAuth()
@Controller({ path: 'me', version: '1' })
export class MePermissionsController {
  constructor(
    private readonly authzCache: AuthzPermissionCacheService,
    private readonly cls: ClsService,
  ) {}

  @ApiOperation({
    summary:
      "The caller's effective permissions, tenant ceiling and data scope in the active workspace.",
    description:
      'Server-computed and authoritative: it accounts for roleIds, group-inherited roles, ancestor groups, JIT grants, overrides, deactivation and the tenant ceiling. Clients must not recompute this.',
  })
  @ApiOkResponse({ type: MyPermissionsResponse })
  @Get('permissions')
  @HttpCode(HttpStatus.OK)
  async myPermissions(): Promise<MyPermissionsResponse> {
    const userId = this.cls.get<string>('userId');
    if (!userId) {
      // The auth guard should have rejected this already; if it did not, an
      // empty 200 would be read by the client as "authenticated with no
      // permissions" and render a logged-in shell with everything hidden.
      throw new UnauthorizedException('Not authenticated');
    }

    const tenantId = this.cls.get<string>('tenantId') ?? null;

    // No active workspace is a legitimate state (mid-onboarding, or a platform
    // operator with no membership). Reported as `tenantId: null` with an empty
    // set rather than an error, so the client can tell "no workspace selected"
    // apart from "workspace selected, nothing granted" — the two need different
    // UI, and conflating them is how a blank app with no explanation happens.
    if (!tenantId) {
      return {
        userId,
        tenantId: null,
        permissions: [],
        tenantCeiling: [],
        fullAccess: false,
        dataScope: DataScope.SELF,
        orgUnitId: null,
      };
    }

    const [explanation, scope] = await Promise.all([
      this.authzCache.explainForUser(userId, tenantId),
      this.authzCache.resolveDataScope(userId, tenantId),
    ]);

    return {
      userId,
      tenantId,
      // `effective` already equals the ceiling when fullAccess is true, so there
      // is no separate owner/admin branch to keep in sync here.
      permissions: explanation.effective,
      tenantCeiling: explanation.tenantCeiling,
      fullAccess: explanation.fullAccess,
      fullAccessReason: explanation.fullAccessReason,
      dataScope: scope.scope,
      orgUnitId: scope.orgUnitId,
    };
  }
}
