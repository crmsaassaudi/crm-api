import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ClsService } from 'nestjs-cls';
import { addDays, addWeeks, addMonths, addYears } from 'date-fns';
import { runWithTenantContext } from '../common/tenancy/tenant-context';
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
 *
 * Tenancy: the cron runs outside any request, so there is no CLS tenant
 * context. The discovery scan is an explicit platform query across tenants;
 * every per-template write then runs inside that template's own tenant
 * context so tenantFilterPlugin scopes it correctly.
 */
@Injectable()
export class RecurringTaskService {
  private readonly logger = new Logger(RecurringTaskService.name);

  constructor(
    @InjectModel(TaskSchemaClass.name)
    private readonly taskModel: Model<TaskSchemaDocument>,
    private readonly cls: ClsService,
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
      // Platform-level scan: recurring templates of every tenant are due here.
      .setOptions({ isPlatformQuery: true })
      .lean()
      .exec();

    if (dueTasks.length === 0) return;

    this.logger.log(
      `[RecurringTask] Processing ${dueTasks.length} due recurring task(s)`,
    );

    for (const template of dueTasks) {
      const tenantId = (template as any).tenantId
        ? String((template as any).tenantId)
        : '';

      if (!tenantId) {
        this.logger.error(
          `[RecurringTask] Skipping template ${String(template._id)}: missing tenantId`,
        );
        continue;
      }

      try {
        await runWithTenantContext(this.cls, tenantId, () =>
          this.processTemplate(template, now),
        );
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

    // ── 1. Claim the occurrence BEFORE creating it ──────────────────
    // Advancing the cursor first means a replica that loses the race creates
    // nothing, instead of every replica creating its own copy of the task.
    const interval: number = recurrenceInterval ?? 1;
    const next = this.calculateNext(occurrenceDate, recurrenceRule, interval);
    const ended = Boolean(
      recurrenceEndsAt && next > new Date(recurrenceEndsAt),
    );

    const claimed = await this.claimOccurrence(
      String(_id),
      occurrenceDate,
      next,
      ended,
    );
    if (!claimed) {
      this.logger.debug(
        `[RecurringTask] Template ${String(_id)} already claimed by another process; skipping`,
      );
      return;
    }

    // ── 2. Create the concrete occurrence task ──────────────────────
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

    this.logger.log(
      `[RecurringTask] Spawned occurrence for "${title}" (template: ${String(_id)}). Next: ${ended ? 'ENDED' : next.toISOString()}`,
    );
  }

  /**
   * Claim this occurrence by advancing `nextOccurrenceAt`, but only if it still
   * holds the value we read. Returns false when another process got there first.
   *
   * `@Cron` fires in every process that loaded ScheduleModule — every API
   * replica and every worker — so a plain read-then-create spawned one duplicate
   * task per replica. The compare-and-set makes the claim the thing that
   * serialises, which also survives two ticks overlapping in one process.
   */
  private async claimOccurrence(
    templateId: string,
    occurrenceDate: Date,
    next: Date,
    ended: boolean,
  ): Promise<boolean> {
    const result = await this.taskModel.updateOne(
      { _id: templateId, nextOccurrenceAt: occurrenceDate },
      ended
        ? { $set: { isRecurring: false }, $unset: { nextOccurrenceAt: '' } }
        : { $set: { nextOccurrenceAt: next } },
    );
    return result.modifiedCount > 0;
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
