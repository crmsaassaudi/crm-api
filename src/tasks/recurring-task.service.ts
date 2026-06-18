import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { addDays, addWeeks, addMonths, addYears } from 'date-fns';
import {
  TaskSchemaClass,
  TaskSchemaDocument,
} from './infrastructure/persistence/document/entities/task.schema';

/**
 * RecurringTaskService
 *
 * Runs every hour to detect recurring tasks whose nextOccurrenceAt ≤ now.
 * For each due template task it:
 *  1. Creates a new concrete child task (with same title/assignee/etc.)
 *  2. Advances nextOccurrenceAt by the recurrence interval
 *  3. If recurrenceEndsAt is exceeded — disables the template
 */
@Injectable()
export class RecurringTaskService {
  private readonly logger = new Logger(RecurringTaskService.name);

  constructor(
    @InjectModel(TaskSchemaClass.name)
    private readonly taskModel: Model<TaskSchemaDocument>,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async spawnDueOccurrences(): Promise<void> {
    const now = new Date();

    const dueTasks = await this.taskModel
      .find({
        isRecurring: true,
        deletedAt: { $exists: false },
        nextOccurrenceAt: { $lte: now },
      })
      .lean()
      .exec();

    if (dueTasks.length === 0) return;

    this.logger.log(
      `[RecurringTask] Processing ${dueTasks.length} due recurring task(s)`,
    );

    for (const template of dueTasks) {
      try {
        await this.processTemplate(template, now);
      } catch (err) {
        this.logger.error(
          `[RecurringTask] Failed for template ${String(template._id)}: ${(err as Error).message}`,
        );
      }
    }
  }

  private async processTemplate(
    template: TaskSchemaClass & { _id: string },
    now: Date,
  ): Promise<void> {
    const {
      _id,
      tenantId,
      title,
      description,
      ownerId,
      categoryId,
      statusId,
      priority,
      tags,
      relatedTo,
      reminderAt,
      recurrenceRule,
      recurrenceInterval,
      recurrenceEndsAt,
      nextOccurrenceAt,
    } = template as any;

    const occurrenceDate: Date = new Date(nextOccurrenceAt ?? now);

    // ── 1. Create the concrete occurrence task ──────────────────────
    const dueDateOffset =
      typeof (template as any).dueDate === 'object'
        ? new Date((template as any).dueDate).getTime() -
          new Date((template as any).createdAt ?? now).getTime()
        : 0;
    const newDueDate = new Date(occurrenceDate.getTime() + dueDateOffset);

    await this.taskModel.create({
      tenantId,
      title,
      description,
      ownerId,
      categoryId,
      statusId,
      priority: priority ?? 'MEDIUM',
      tags,
      relatedTo,
      reminderAt,
      dueDate: newDueDate,
      isRecurring: false,
      parentTaskId: _id,
      createdById: ownerId ?? 'system',
      updatedById: ownerId ?? 'system',
    });

    // ── 2. Advance nextOccurrenceAt ───────────────────────────────────
    const interval: number = recurrenceInterval ?? 1;
    const next = this.calculateNext(occurrenceDate, recurrenceRule, interval);

    // ── 3. Check if recurrence has ended ─────────────────────────────
    const ended = recurrenceEndsAt && next > new Date(recurrenceEndsAt);

    await this.taskModel.updateOne(
      { _id },
      {
        $set: {
          nextOccurrenceAt: ended ? undefined : next,
          ...(ended ? { isRecurring: false } : {}),
        },
      },
    );

    this.logger.log(
      `[RecurringTask] Spawned occurrence for "${title}" (template: ${String(_id)}). Next: ${ended ? 'ENDED' : next.toISOString()}`,
    );
  }

  /** Compute the next occurrence date from `from` by applying recurrence rule + interval */
  private calculateNext(
    from: Date,
    rule: string | undefined,
    interval: number,
  ): Date {
    switch (rule) {
      case 'daily':
        return addDays(from, interval);
      case 'weekly':
        return addWeeks(from, interval);
      case 'monthly':
        return addMonths(from, interval);
      case 'yearly':
        return addYears(from, interval);
      default:
        // Fallback to daily if rule is unknown
        return addDays(from, interval);
    }
  }
}
