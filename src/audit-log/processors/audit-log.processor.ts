import { Processor, OnWorkerEvent, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AuditLogSchemaClass } from '../entities/audit-log.schema';
import { AuditQueueJobData } from '../types/audit-event.types';

/**
 * BullMQ Worker that persists pre-computed audit diffs to MongoDB.
 *
 * This worker is intentionally simple:
 * - Does NOT compute diffs (already done at AuditLogListener)
 * - Does NOT generate timestamps (uses `t` from payload)
 * - Only reads job payload and writes to MongoDB
 *
 * Uses WorkerHost (not BaseTenantConsumer) because:
 * - Audit jobs don't need CLS tenant context injection
 * - All required data is self-contained in the job payload
 * - Avoids side-effects from tenant-filter plugin
 */
@Processor('audit-queue')
export class AuditLogProcessor extends WorkerHost {
  private readonly logger = new Logger(AuditLogProcessor.name);

  constructor(
    @InjectModel(AuditLogSchemaClass.name, 'audit-log-db-connection')
    private readonly model: Model<AuditLogSchemaClass>,
  ) {
    super();
  }

  async process(job: Job<AuditQueueJobData>): Promise<void> {
    const {
      t,
      tenantId,
      entityType,
      entityId,
      actorId,
      src,
      ctx,
      ip,
      ua,
      changes,
    } = job.data;

    // t comes from payload (actual request time), NOT new Date()
    // changes[] already computed at Listener — worker only persists
    await this.model.create({
      t: new Date(t),
      tenantId,
      entityType,
      entityId,
      actorId: actorId ?? 'system',
      src: src ?? 'S',
      ctx,
      ip,
      ua,
      changes,
    });
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, error: Error) {
    this.logger.error(`[AuditQueue] Job ${job.id} failed: ${error.message}`);
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job) {
    this.logger.log(
      `[AuditQueue] Job ${job.id} completed — ${job.data?.entityType}:${job.data?.entityId}`,
    );
  }
}
