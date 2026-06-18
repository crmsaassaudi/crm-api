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
import { CreateCustomRoleDto, UpdateCustomRoleDto } from './custom-roles.dto';
import { RequirePermission } from './index';

@ApiTags('Roles')
@ApiBearerAuth()
@Controller({ path: 'roles', version: '1' })
export class CustomRolesController {
  constructor(private readonly service: CustomRolesService) {}

  // ── Permission matrix meta ─────────────────────────────────────────────────

  @Get('permission-matrix')
  @ApiOperation({ summary: 'Get full permission registry grouped by resource' })
  @RequirePermission('view', 'settings')
  getPermissionMatrix() {
    return this.service.getPermissionMatrix();
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
