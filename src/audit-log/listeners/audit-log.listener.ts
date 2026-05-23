import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { runWithTenantContext } from '../../common/tenancy/tenant-context';
import { AuditLogRecordInput, AuditLogService } from '../audit-log.service';

@Injectable()
export class AuditLogListener {
  private readonly logger = new Logger(AuditLogListener.name);

  constructor(
    private readonly auditLogService: AuditLogService,
    private readonly cls: ClsService,
  ) {}

  @OnEvent('audit.record', { async: true })
  async handleAuditRecord(
    event: AuditLogRecordInput & {
      tenantId?: string;
      ipAddress?: string;
      userAgent?: string;
    },
  ): Promise<void> {
    try {
      const record = () => this.auditLogService.record(event);
      if (event.tenantId) {
        await runWithTenantContext(this.cls, event.tenantId, record);
        return;
      }

      await record();
    } catch (error) {
      this.logger.warn(
        `[AuditLog] Failed to persist audit.record: ${(error as Error).message}`,
      );
    }
  }
}
