import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiParam, ApiQuery } from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import { RequirePermission } from '../common/permissions/permission.decorator';
import { AuditLogService } from './audit-log.service';

@ApiTags('Audit Logs')
@ApiBearerAuth()
@Controller({ path: 'audit-logs', version: '1' })
export class AuditLogController {
  constructor(
    private readonly auditLogService: AuditLogService,
    private readonly cls: ClsService,
  ) {}

  @Get(':entityType/:entityId')
  @RequirePermission('view', 'audit_logs')
  @ApiOperation({
    summary: 'Get entity change history',
    description:
      'Returns field-level change history for a specific entity with cursor-based pagination.',
  })
  @ApiParam({ name: 'entityType', enum: ['CONTACT', 'DEAL', 'TICKET'] })
  @ApiParam({ name: 'entityId', description: 'MongoDB ObjectId of the entity' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  async getHistory(
    @Param('entityType') entityType: string,
    @Param('entityId') entityId: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    const tenantId =
      this.cls.get('activeTenantId') || this.cls.get('tenantId');

    return this.auditLogService.getEnhancedAuditLogs({
      tenantId,
      entityType: entityType.toUpperCase(),
      entityId,
      limit: Math.min(Number(limit) || 20, 100),
      cursor,
    });
  }
}
