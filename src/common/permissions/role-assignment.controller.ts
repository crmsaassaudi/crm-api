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

  @Get('certification')
  @ApiOperation({
    summary: 'Generate an access-certification and orphaned-grant report',
  })
  @RequirePermission('approve', 'settings')
  certification(@Req() req: any) {
    return this.service.certificationReport(
      resolveRequestTenantId(this.cls, req),
      new Date(),
    );
  }

  @Post()
  @ApiOperation({
    summary: 'Request a time-bound role assignment (requires two approvals)',
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
      expiresAt: new Date(dto.expiresAt),
      reason: dto.reason,
    });
  }

  @Post(':id/approve')
  @ApiOperation({ summary: 'Record an independent assignment approval' })
  @RequirePermission('approve', 'settings')
  approve(@Req() req: any, @Param('id') id: string) {
    const tenantId = resolveRequestTenantId(this.cls, req);
    return this.service.approve(
      tenantId,
      id,
      resolveActorId(this.cls, req),
      new Date(),
    );
  }

  @Post(':id/reject')
  @ApiOperation({ summary: 'Reject a pending role assignment' })
  @RequirePermission('approve', 'settings')
  reject(@Req() req: any, @Param('id') id: string) {
    const tenantId = resolveRequestTenantId(this.cls, req);
    return this.service.reject(
      tenantId,
      id,
      resolveActorId(this.cls, req),
      new Date(),
    );
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
