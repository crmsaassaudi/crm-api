import { Controller, Get, Query, Req } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { AuthzAuditService } from './authz-audit.service';
import { AuthzAuditCategory } from './authz-audit-log.schema';
import { RequirePermission } from '../permissions';
import { resolveRequestTenantId } from '../tenancy/resolve-request-tenant';

@ApiTags('Authorization Audit')
@ApiBearerAuth()
@Controller({ path: 'authz-audit', version: '1' })
export class AuthzAuditController {
  constructor(
    private readonly service: AuthzAuditService,
    private readonly cls: ClsService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List authorization-governance audit entries' })
  @RequirePermission('view', 'audit_logs')
  list(
    @Req() req: any,
    @Query('category') category?: AuthzAuditCategory,
    @Query('targetType') targetType?: string,
    @Query('targetId') targetId?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    const tenantId = resolveRequestTenantId(this.cls, req);
    return this.service.query({
      tenantId,
      category,
      targetType,
      targetId,
      limit: limit ? Number(limit) : undefined,
      cursor,
    });
  }
}
