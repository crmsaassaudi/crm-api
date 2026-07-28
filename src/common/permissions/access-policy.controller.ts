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
import { AccessPolicyService } from './access-policy.service';
import {
  CreateAccessPolicyDto,
  UpdateAccessPolicyDto,
  SimulateAccessPolicyDto,
  RollbackAccessPolicyDto,
} from './access-policy.dto';
import { RequirePermission } from './index';
import { resolveRequestTenantId } from '../tenancy/resolve-request-tenant';

@ApiTags('Access Policies (ABAC)')
@ApiBearerAuth()
@Controller({ path: 'access-policies', version: '1' })
export class AccessPolicyController {
  constructor(
    private readonly service: AccessPolicyService,
    private readonly cls: ClsService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List ABAC access policies for the tenant' })
  @RequirePermission('view', 'settings')
  findAll(@Req() req: any) {
    const tenantId = resolveRequestTenantId(this.cls, req);
    return this.service.findAll(tenantId);
  }

  @Post('simulate')
  @ApiOperation({ summary: 'Simulate an ABAC policy without publishing it' })
  @RequirePermission('manage_system', 'settings')
  simulate(@Body() dto: SimulateAccessPolicyDto) {
    return this.service.simulate(dto.policy, dto.context);
  }

  @Get(':id/versions')
  @ApiOperation({ summary: 'List immutable policy revisions' })
  @RequirePermission('view', 'settings')
  versions(@Req() req: any, @Param('id') id: string) {
    return this.service.listVersions(
      id,
      resolveRequestTenantId(this.cls, req),
    );
  }

  @Post(':id/rollback')
  @ApiOperation({ summary: 'Publish a rollback as a new policy revision' })
  @RequirePermission('manage_system', 'settings')
  rollback(
    @Req() req: any,
    @Param('id') id: string,
    @Body() dto: RollbackAccessPolicyDto,
  ) {
    return this.service.rollback(
      id,
      resolveRequestTenantId(this.cls, req),
      dto.revision,
    );
  }

  @Post()
  @ApiOperation({ summary: 'Create an ABAC access policy' })
  @RequirePermission('manage_system', 'settings')
  create(@Req() req: any, @Body() dto: CreateAccessPolicyDto) {
    const tenantId = resolveRequestTenantId(this.cls, req);
    return this.service.create(tenantId, dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update an ABAC access policy' })
  @RequirePermission('manage_system', 'settings')
  update(
    @Req() req: any,
    @Param('id') id: string,
    @Body() dto: UpdateAccessPolicyDto,
  ) {
    const tenantId = resolveRequestTenantId(this.cls, req);
    return this.service.update(id, tenantId, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete an ABAC access policy' })
  @RequirePermission('manage_system', 'settings')
  async remove(@Req() req: any, @Param('id') id: string) {
    const tenantId = resolveRequestTenantId(this.cls, req);
    await this.service.remove(id, tenantId);
    return { success: true };
  }
}
