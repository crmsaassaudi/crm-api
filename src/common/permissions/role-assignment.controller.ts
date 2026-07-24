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
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { RoleAssignmentService } from './role-assignment.service';
import { GrantRoleAssignmentDto } from './role-assignment.dto';
import { RequirePermission } from './index';

@ApiTags('Role Assignments')
@ApiBearerAuth()
@Controller({ path: 'role-assignments', version: '1' })
export class RoleAssignmentController {
  constructor(private readonly service: RoleAssignmentService) {}

  @Get()
  @ApiOperation({ summary: 'List role assignments (JIT/permanent) for a tenant' })
  @RequirePermission('view', 'settings')
  list(@Req() req: any, @Query('principalId') principalId?: string) {
    const tenantId: string = req.user?.tenantId ?? req.tenantId;
    return this.service.listForTenant(tenantId, { principalId });
  }

  @Post()
  @ApiOperation({ summary: 'Grant a role to a principal (optionally time-bound)' })
  @RequirePermission('manage_system', 'settings')
  grant(@Req() req: any, @Body() dto: GrantRoleAssignmentDto) {
    const tenantId: string = req.user?.tenantId ?? req.tenantId;
    const grantedById: string = String(
      req.user?.userId ?? req.user?.id ?? req.user?.sub,
    );
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
    const tenantId: string = req.user?.tenantId ?? req.tenantId;
    const revokedById: string = String(
      req.user?.userId ?? req.user?.id ?? req.user?.sub,
    );
    await this.service.revoke(tenantId, id, revokedById, new Date());
    return { success: true };
  }
}
