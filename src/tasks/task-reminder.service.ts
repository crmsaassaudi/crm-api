import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { EventEmitter2 } from '@nestjs/event-emitter';
import Redis from 'ioredis';
import {
  TaskSchemaClass,
  TaskSchemaDocument,
} from './infrastructure/persistence/document/entities/task.schema';
import { IOREDIS_CLIENT } from '../redis/redis.tokens';
import { TASK_REMINDER_CHANNEL } from './tasks.constants';

/** How many reminders one sweep will dispatch. Keeps a backlog from monopolising a tick. */
const BATCH_SIZE = 500;

/**
 * How late a reminder may be and still be delivered.
 *
 * A reminder for last month is noise, not information: if the worker was down
 * for a week, waking up and firing a thousand stale reminders is worse than
 * dropping them. Skipped ones are logged and marked, so the count is visible
 * rather than silent.
 */
const MAX_LATENESS_MS = 24 * 60 * 60 * 1000;

/**
 * Delivers task reminders.
 *
 * Exists because `reminderAt` was write-only. The field was on the schema, the
 * DTO accepted it, the mapper persisted it, the UI let users set it — and a
 * repo-wide search for readers outside `src/tasks/` returned nothing. So the
 * product asked for a time, promised a reminder, and never sent one. That is the
 * worst shape a defect can take: the system is confidently silent.
 *
 * Delivery reuses the two seams the platform already has rather than inventing a
 * third: the `internal.notification` event (the same contract the automation
 * engine's InternalNotificationExecutor emits) and the `socket:*` Redis channel
 * that CrmRealtimeGateway bridges to Socket.IO rooms. Note that no consumer
 * *persists* in-app notifications yet — that gap is platform-wide and predates
 * this service — so a reminder reaches a connected client live and is otherwise
 * recorded only in the audit trail.
 */
@Injectable()
export class TaskReminderService {
  private readonly logger = new Logger(TaskReminderService.name);

  constructor(
    @InjectModel(TaskSchemaClass.name)
    private readonly taskModel: Model<TaskSchemaDocument>,
    @Optional() @Inject(IOREDIS_CLIENT) private readonly redis?: Redis,
    @Optional() private readonly events?: EventEmitter2,
  ) {}

  /**
   * Every five minutes. The granularity a user expects from "remind me at 09:00"
   * is minutes, not hours, and a five-minute sweep over an indexed, bounded query
   * is cheap enough to run that often.
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async dispatchDueReminders(): Promise<{ sent: number; skipped: number }> {
    const now = new Date();

    const due = await this.taskModel
      .find({
        reminderAt: { $ne: null, $lte: now },
        // The claim field doubles as the "already handled" marker.
        reminderSentAt: null,
        deletedAt: null,
      })
      // Cross-tenant by design: reminders come due for every tenant at once.
      // Explicit, because tenantFilterPlugin fails closed on a missing CLS tenant
      // and a cron has no request to take one from.
      .setOptions({ isPlatformQuery: true })
      .sort({ reminderAt: 1 })
      .limit(BATCH_SIZE)
      .lean()
      .exec();

    if (due.length === 0) return { sent: 0, skipped: 0 };

    let sent = 0;
    let skipped = 0;

    for (const task of due) {
      const reminderAt = new Date(task.reminderAt as Date);
      const lateBy = now.getTime() - reminderAt.getTime();

      // Claim BEFORE delivering. `@Cron` fires in every process that loaded
      // ScheduleModule, so without a compare-and-set on `reminderSentAt` each
      // replica would send its own copy of the same reminder. Claiming first
      // means a lost race sends nothing, rather than everyone sending.
      const claimed = await this.claim(String(task._id));
      if (!claimed) continue;

      if (lateBy > MAX_LATENESS_MS) {
        skipped++;
        this.logger.warn(
          `[TaskReminder] Skipped stale reminder task=${String(task._id)} ` +
            `late_by=${Math.round(lateBy / 3_600_000)}h`,
        );
        continue;
      }

      try {
        await this.deliver(task);
        sent++;
      } catch (error) {
        // The claim stands. A delivery that failed is not retried, and saying so
        // out loud is the point: silently leaving it unclaimed would make the
        // next sweep resend, and there is no delivery receipt to deduplicate on.
        this.logger.error(
          `[TaskReminder] Delivery failed for task=${String(task._id)}; ` +
            `reminder will NOT be retried: ${
              error instanceof Error ? error.message : String(error)
            }`,
        );
      }
    }

    if (sent > 0 || skipped > 0) {
      this.logger.log(
        `[TaskReminder] ${sent} reminder(s) dispatched, ${skipped} stale skipped`,
      );
    }
    return { sent, skipped };
  }

  /**
   * Take ownership of one reminder.
   *
   * The `reminderSentAt: null` predicate is the whole mechanism — it is what
   * makes the claim atomic across replicas.
   */
  private async claim(taskId: string): Promise<boolean> {
    const result = await this.taskModel
      .updateOne(
        { _id: taskId, reminderSentAt: null },
        { $set: { reminderSentAt: new Date() } },
      )
      .setOptions({ isPlatformQuery: true } as any)
      .exec();
    return result.modifiedCount > 0;
  }

  private async deliver(task: any): Promise<void> {
    const tenantId = String(task.tenantId);
    const payload = {
      tenantId,
      taskId: String(task._id),
      ownerId: task.ownerId ? String(task.ownerId) : null,
      title: task.title,
      dueDate: task.dueDate,
      reminderAt: task.reminderAt,
      priority: task.priority,
    };

    // Live delivery to whoever is connected, through the bridge every other
    // module's async notifications already use.
    if (this.redis) {
      await this.redis.publish(TASK_REMINDER_CHANNEL, JSON.stringify(payload));
    }

    // Same event the automation engine's internal_notification action emits, so
    // any future consumer picks up reminders without special-casing them.
    this.events?.emit('internal.notification', {
      tenantId,
      recipientType: 'owner',
      recipientIds: payload.ownerId ? [payload.ownerId] : [],
      title: `Nhắc việc: ${task.title}`,
      message: `Task "${task.title}" đến hạn ${new Date(task.dueDate).toISOString()}.`,
      source: 'task-reminder',
      context: { recordType: 'Task', recordId: payload.taskId },
    });
  }
}
