import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { AuditDiffEngine } from '../utils/audit-diff-engine';
import { CustomFieldsCacheService } from '../services/custom-fields-cache.service';
import { AuditEntityUpdatedEvent } from '../types/audit-event.types';

@Injectable()
export class AuditLogListener {
  private readonly logger = new Logger(AuditLogListener.name);

  constructor(
    // [PATCH R2] Listener self-resolves labels — CRM Services don't need to know
    private readonly customFieldsCache: CustomFieldsCacheService,
    @InjectQueue('audit-queue') private readonly auditQueue: Queue,
  ) {}

  // ── Entity update handlers ──
  // Captures field-level diffs for contact/deal/ticket updates.
  // Diff runs HERE (async, outside request thread) — compact payload goes to BullMQ Worker.

  @OnEvent('contact.updated', { async: true })
  @OnEvent('deal.updated', { async: true })
  @OnEvent('ticket.updated', { async: true })
  async handleEntityUpdated(payload: AuditEntityUpdatedEvent): Promise<void> {
    try {
      // Self-resolve labels map from cache
      // Fail-open: if cache/DB errors, labels = {} — log still records, just without l
      const labelsMap = await this.customFieldsCache.getLabelsForTenant(
        payload.tenantId,
        payload.entityType,
      );

      // Diff at Listener — only changes[] (< 500 bytes) goes to Redis
      const changes = AuditDiffEngine.computeDelta(
        payload.oldSnapshot,
        payload.newSnapshot,
        labelsMap,
        payload.entityType,
      );

      // Skip if no meaningful changes detected (e.g. only updatedAt changed)
      if (changes.length === 0) {
        this.logger.log(
          `[AuditLog] ${payload.entityType}:${payload.entityId} — no meaningful changes, skipping`,
        );
        return;
      }

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
          changes,
        },
        {
          attempts: 3,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: true,
          removeOnFail: 100,
        },
      );

      this.logger.log(
        `[AuditLog] Enqueued ${payload.entityType}:${payload.entityId} — ${changes.length} change(s)`,
      );
    } catch (error) {
      // Non-blocking: audit failures must NEVER crash the API
      this.logger.warn(
        `[AuditLog] Failed to process ${payload.entityType}.updated: ${(error as Error).message}`,
      );
    }
  }
}
