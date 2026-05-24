import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { ClsService } from 'nestjs-cls';
import { runWithTenantContext } from '../../common/tenancy/tenant-context';
import { AuditLogRecordInput, AuditLogService } from '../audit-log.service';
import { AuditDiffEngine } from '../utils/audit-diff-engine';
import { CustomFieldsCacheService } from '../services/custom-fields-cache.service';
import { AuditEntityUpdatedEvent } from '../types/audit-event.types';

@Injectable()
export class AuditLogListener {
  private readonly logger = new Logger(AuditLogListener.name);

  constructor(
    private readonly auditLogService: AuditLogService,
    private readonly cls: ClsService,
    // [PATCH R2] Listener self-resolves labels — CRM Services don't need to know
    private readonly customFieldsCache: CustomFieldsCacheService,
    @InjectQueue('audit-queue') private readonly auditQueue: Queue,
  ) {}

  // ── Legacy event handler (backward compat) ──
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

  // ── Enhanced entity update handlers ──
  // [PATCH P2] Diff runs HERE (async, outside request thread) — NOT at Worker
  // [PATCH R2] Labels resolved HERE — CRM Services don't pass labels

  @OnEvent('contact.updated', { async: true })
  @OnEvent('deal.updated', { async: true })
  @OnEvent('ticket.updated', { async: true })
  async handleEntityUpdated(
    payload: AuditEntityUpdatedEvent,
  ): Promise<void> {
    try {
      // [PATCH R2] Self-resolve labels map from cache
      // Fail-open: if cache/DB errors, labels = {} — log still records, just without l
      const labelsMap = await this.customFieldsCache.getLabelsForTenant(
        payload.tenantId,
        payload.entityType,
      );

      // [PATCH P2] Diff at Listener — only changes[] (<500 bytes) goes to Redis
      // [PATCH R3] truncate() is embedded in AuditDiffEngine.computeDelta()
      const changes = AuditDiffEngine.computeDelta(
        payload.oldSnapshot,
        payload.newSnapshot,
        labelsMap,
      );

      // Skip if no meaningful changes detected (e.g. only updatedAt changed)
      if (changes.length === 0) return;

      // Enqueue compact job payload — Worker just persists, no diff
      await this.auditQueue.add(
        'process-audit',
        {
          t: payload.t instanceof Date ? payload.t.toISOString() : payload.t,
          tenantId: payload.tenantId,
          entityType: payload.entityType,
          entityId: payload.entityId,
          actorId: payload.actorId || 'system',
          src: payload.src || 'S',
          ctx: payload.ctx,
          ip: payload.ip,
          ua: payload.ua,
          changes, // < 500 bytes thanks to truncation [R3] + diff-only [P2]
        },
        {
          attempts: 3,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: true,
          removeOnFail: 100,
        },
      );
    } catch (error) {
      // Non-blocking: audit failures must NEVER crash the API
      this.logger.warn(
        `[AuditLog] Failed to process ${payload.entityType}.updated: ${(error as Error).message}`,
      );
    }
  }
}
