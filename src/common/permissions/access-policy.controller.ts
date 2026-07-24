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
import { AccessPolicyService } from './access-policy.service';
import {
  CreateAccessPolicyDto,
  UpdateAccessPolicyDto,
} from './access-policy.dto';
import { RequirePermission } from './index';

@ApiTags('Access Policies (ABAC)')
@ApiBearerAuth()
@Controller({ path: 'access-policies', version: '1' })
export class AccessPolicyController {
  constructor(private readonly service: AccessPolicyService) {}

  @Get()
  @ApiOperation({ summary: 'List ABAC access policies for the tenant' })
  @RequirePermission('view', 'settings')
  findAll(@Req() req: any) {
    const tenantId: string = req.user?.tenantId ?? req.tenantId;
    return this.service.findAll(tenantId);
  }

  @Post()
  @ApiOperation({ summary: 'Create an ABAC access policy' })
  @RequirePermission('manage_system', 'settings')
  create(@Req() req: any, @Body() dto: CreateAccessPolicyDto) {
    const tenantId: string = req.user?.tenantId ?? req.tenantId;
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
    const tenantId: string = req.user?.tenantId ?? req.tenantId;
    return this.service.update(id, tenantId, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete an ABAC access policy' })
  @RequirePermission('manage_system', 'settings')
  async remove(@Req() req: any, @Param('id') id: string) {
    const tenantId: string = req.user?.tenantId ?? req.tenantId;
    await this.service.remove(id, tenantId);
    return { success: true };
  }
}
