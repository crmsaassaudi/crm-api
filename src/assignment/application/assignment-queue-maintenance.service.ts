import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { MetricsService } from '../../observability/metrics.service';
import {
  AssignmentQueueItemDocument,
  AssignmentQueueItemSchemaClass,
} from '../infrastructure/persistence/assignment-queue-item.schema';
import {
  AssignmentOutboxEventDocument,
  AssignmentOutboxEventSchemaClass,
} from '../infrastructure/persistence/assignment-outbox-event.schema';

const STALE_OPERATION_MS = 5 * 60_000;
const ESCALATION_SLA_MS = 15 * 60_000;

/** Recovers queue commands interrupted after their CAS but before completion. */
@Injectable()
export class AssignmentQueueMaintenanceService {
  private readonly logger = new Logger(AssignmentQueueMaintenanceService.name);

  constructor(
    @InjectModel(AssignmentQueueItemSchemaClass.name)
    private readonly queue: Model<AssignmentQueueItemDocument>,
    @Optional() private readonly metrics?: MetricsService,
    @Optional()
    @InjectModel(AssignmentOutboxEventSchemaClass.name)
    private readonly outbox?: Model<AssignmentOutboxEventDocument>,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async recoverStaleOperations(): Promise<number> {
    const result = await this.queue
      .updateMany(
        {
          status: { $in: ['claiming', 'retrying'] },
          operationStartedAt: {
            $lt: new Date(Date.now() - STALE_OPERATION_MS),
          },
        },
        {
          $set: { status: 'queued', lastAttemptAt: new Date() },
          $unset: { operationId: 1, operationStartedAt: 1 },
          $inc: { attemptCount: 1 },
        },
      )
      .exec();
    const recovered = result.modifiedCount ?? 0;
    if (recovered > 0) {
      this.metrics?.incrementCounter(
        'crm_assignment_queue_stale_operations_recovered_total',
        {},
        recovered,
      );
      this.logger.warn(
        `Recovered ${recovered} stale assignment queue operation(s)`,
      );
    }
    return recovered;
  }

  /**
   * Atomically marks overdue work and creates a durable escalation event.
   * Raw collections are intentional: this is a platform cron spanning tenants,
   * while request-path queries remain protected by the tenant plugin.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async escalateOverdueItems(): Promise<number> {
    if (!this.outbox) return 0;
    const due = await this.queue.collection
      .find({
        status: 'queued',
        escalatedAt: null,
        $or: [
          { slaDueAt: { $lte: new Date() } },
          { queuedAt: { $lt: new Date(Date.now() - ESCALATION_SLA_MS) } },
        ],
      })
      .sort({ priority: -1, slaDueAt: 1, queuedAt: 1, _id: 1 })
      .limit(100)
      .toArray();

    let escalated = 0;
    for (const item of due) {
      const session = await this.queue.db.startSession();
      try {
        await session.withTransaction(async () => {
          const marked = await this.queue.collection.updateOne(
            { _id: item._id, status: 'queued', escalatedAt: null },
            {
              $set: { escalatedAt: new Date() },
              $inc: { escalationCount: 1 },
            },
            { session },
          );
          if (marked.modifiedCount !== 1) return;
          const eventId = `queue:${String(item._id)}:sla:1`;
          await this.outbox!.collection.updateOne(
            { tenantId: item.tenantId, eventId },
            {
              $setOnInsert: {
                tenantId: item.tenantId,
                eventId,
                eventType: 'assignment.queue.escalated',
                aggregateId: String(item._id),
                payload: {
                  queueItemId: String(item._id),
                  tenantId: String(item.tenantId),
                  objectType: item.objectType,
                  entityId: item.entityId,
                  groupId: String(item.groupId),
                  queuedAt: item.queuedAt,
                  priority: item.priority ?? 50,
                  slaDueAt: item.slaDueAt ?? null,
                  escalationLevel: 1,
                },
                status: 'pending',
                retryCount: 0,
                createdAt: new Date(),
                updatedAt: new Date(),
              },
            },
            { upsert: true, session },
          );
          escalated++;
        });
      } finally {
        await session.endSession();
      }
    }
    if (escalated > 0) {
      this.metrics?.incrementCounter(
        'crm_assignment_queue_escalations_total',
        { level: '1' },
        escalated,
      );
      this.logger.warn(
        `Escalated ${escalated} overdue assignment queue item(s)`,
      );
    }
    return escalated;
  }
}
