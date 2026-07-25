import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Req,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { CustomRolesService } from './custom-roles.service';
import {
  CloneCustomRoleDto,
  CreateCustomRoleDto,
  UpdateCustomRoleDto,
} from './custom-roles.dto';
import { RequirePermission } from './index';

@ApiTags('Roles')
@ApiBearerAuth()
@Controller({ path: 'roles', version: '1' })
export class CustomRolesController {
  constructor(private readonly service: CustomRolesService) {}

  // ── Permission matrix meta ─────────────────────────────────────────────────

  @Get('permission-matrix')
  @ApiOperation({
    summary:
      "Get the permission registry grouped by resource, plus this tenant's ceiling",
  })
  @RequirePermission('view', 'settings')
  getPermissionMatrix(@Req() req: any) {
    const tenantId: string = req.user?.tenantId ?? req.tenantId;
    return this.service.getPermissionMatrix(tenantId);
  }

  // ── CRUD ───────────────────────────────────────────────────────────────────

  @Get()
  @ApiOperation({ summary: 'List all custom roles for the current tenant' })
  @RequirePermission('view', 'settings')
  findAll(@Req() req: any) {
    const tenantId: string = req.user?.tenantId ?? req.tenantId;
    return this.service.findAll(tenantId);
  }

  @Post()
  @ApiOperation({ summary: 'Create a new custom role' })
  @RequirePermission('manage_system', 'settings')
  create(@Req() req: any, @Body() dto: CreateCustomRoleDto) {
    const tenantId: string = req.user?.tenantId ?? req.tenantId;
    return this.service.create(tenantId, dto);
  }

  @Post(':id/clone')
  @ApiOperation({
    summary:
      'Clone a role (the supported way to customise an immutable system role)',
  })
  @RequirePermission('manage_system', 'settings')
  clone(
    @Req() req: any,
    @Param('id') id: string,
    @Body() dto: CloneCustomRoleDto,
  ) {
    const tenantId: string = req.user?.tenantId ?? req.tenantId;
    return this.service.clone(id, tenantId, dto);
  }

  @Patch(':id')
  @ApiOperation({
    summary: "Update a custom role's name, description, or permissions",
  })
  @RequirePermission('manage_system', 'settings')
  update(
    @Req() req: any,
    @Param('id') id: string,
    @Body() dto: UpdateCustomRoleDto,
  ) {
    const tenantId: string = req.user?.tenantId ?? req.tenantId;
    return this.service.update(id, tenantId, dto);
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Delete a custom role (system roles are protected)',
  })
  @RequirePermission('manage_system', 'settings')
  async remove(@Req() req: any, @Param('id') id: string) {
    const tenantId: string = req.user?.tenantId ?? req.tenantId;
    await this.service.remove(id, tenantId);
    return { success: true };
  }
}
