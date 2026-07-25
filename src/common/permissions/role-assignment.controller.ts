import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  Query,
  Req,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { RoleAssignmentService } from './role-assignment.service';
import { GrantRoleAssignmentDto } from './role-assignment.dto';
import { RequirePermission } from './index';
import { resolveRequestTenantId } from '../tenancy/resolve-request-tenant';
import { getUserId } from '../cls/cls-context.helper';

/**
 * The acting user's Mongo id. CLS carries the resolved local id; the raw token
 * only has the Keycloak `sub`, so preferring the request would store a foreign
 * id in the audit trail.
 */
const resolveActorId = (cls: ClsService, req: any): string =>
  String(getUserId(cls) ?? req.user?.userId ?? req.user?.id ?? req.user?.sub);

@ApiTags('Role Assignments')
@ApiBearerAuth()
@Controller({ path: 'role-assignments', version: '1' })
export class RoleAssignmentController {
  constructor(
    private readonly service: RoleAssignmentService,
    private readonly cls: ClsService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'List role assignments (JIT/permanent) for a tenant',
  })
  @RequirePermission('view', 'settings')
  list(@Req() req: any, @Query('principalId') principalId?: string) {
    const tenantId = resolveRequestTenantId(this.cls, req);
    return this.service.listForTenant(tenantId, { principalId });
  }

  @Post()
  @ApiOperation({
    summary: 'Grant a role to a principal (optionally time-bound)',
  })
  @RequirePermission('manage_system', 'settings')
  grant(@Req() req: any, @Body() dto: GrantRoleAssignmentDto) {
    const tenantId = resolveRequestTenantId(this.cls, req);
    const grantedById = resolveActorId(this.cls, req);
    return this.service.grant({
      tenantId,
      principalType: dto.principalType,
      principalId: dto.principalId,
      roleId: dto.roleId,
      grantedById,
      expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
      reason: dto.reason,
    });
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Revoke a role assignment (soft, auditable)' })
  @RequirePermission('manage_system', 'settings')
  async revoke(@Req() req: any, @Param('id') id: string) {
    const tenantId = resolveRequestTenantId(this.cls, req);
    const revokedById = resolveActorId(this.cls, req);
    await this.service.revoke(tenantId, id, revokedById, new Date());
    return { success: true };
  }
}
