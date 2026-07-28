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
import { ClsService } from 'nestjs-cls';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { CustomRolesService } from './custom-roles.service';
import {
  CloneCustomRoleDto,
  CreateCustomRoleDto,
  UpdateCustomRoleDto,
  RollbackCustomRoleDto,
} from './custom-roles.dto';
import { RequirePermission } from './index';
import { resolveRequestTenantId } from '../tenancy/resolve-request-tenant';

@ApiTags('Roles')
@ApiBearerAuth()
@Controller({ path: 'roles', version: '1' })
export class CustomRolesController {
  constructor(
    private readonly service: CustomRolesService,
    private readonly cls: ClsService,
  ) {}

  // ── Permission matrix meta ─────────────────────────────────────────────────

  @Get('permission-matrix')
  @ApiOperation({
    summary:
      "Get the permission registry grouped by resource, plus this tenant's ceiling",
  })
  @RequirePermission('view', 'settings')
  getPermissionMatrix(@Req() req: any) {
    const tenantId = resolveRequestTenantId(this.cls, req);
    return this.service.getPermissionMatrix(tenantId);
  }

  // ── CRUD ───────────────────────────────────────────────────────────────────

  @Get()
  @ApiOperation({ summary: 'List all custom roles for the current tenant' })
  @RequirePermission('view', 'settings')
  findAll(@Req() req: any) {
    const tenantId = resolveRequestTenantId(this.cls, req);
    return this.service.findAll(tenantId);
  }

  @Post()
  @ApiOperation({ summary: 'Create a new custom role' })
  @RequirePermission('manage_system', 'settings')
  create(@Req() req: any, @Body() dto: CreateCustomRoleDto) {
    const tenantId = resolveRequestTenantId(this.cls, req);
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
    const tenantId = resolveRequestTenantId(this.cls, req);
    return this.service.clone(id, tenantId, dto);
  }

  @Get(':id/versions')
  @ApiOperation({ summary: 'List immutable custom-role revisions' })
  @RequirePermission('view', 'settings')
  versions(@Req() req: any, @Param('id') id: string) {
    return this.service.listVersions(
      id,
      resolveRequestTenantId(this.cls, req),
    );
  }

  @Post(':id/rollback')
  @ApiOperation({ summary: 'Publish a rollback as a new role revision' })
  @RequirePermission('manage_system', 'settings')
  rollback(
    @Req() req: any,
    @Param('id') id: string,
    @Body() dto: RollbackCustomRoleDto,
  ) {
    return this.service.rollback(
      id,
      resolveRequestTenantId(this.cls, req),
      dto.revision,
    );
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
    const tenantId = resolveRequestTenantId(this.cls, req);
    return this.service.update(id, tenantId, dto);
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Delete a custom role (system roles are protected)',
  })
  @RequirePermission('manage_system', 'settings')
  async remove(@Req() req: any, @Param('id') id: string) {
    const tenantId = resolveRequestTenantId(this.cls, req);
    await this.service.remove(id, tenantId);
    return { success: true };
  }
}
