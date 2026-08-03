import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ClsService } from 'nestjs-cls';
import { runWithTenantContext } from '../common/tenancy/tenant-context';
import { advanceOccurrence } from './domain/task-recurrence';
import { TaskRecurrenceRule } from './tasks.constants';
import {
  TaskSchemaClass,
  TaskSchemaDocument,
} from './infrastructure/persistence/document/entities/task.schema';
import { DEFAULT_TASK_PRIORITY } from './tasks.constants';

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

    // 1. Claim the occurrence BEFORE creating it
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

    // 2. Create the concrete occurrence task
    //
    // The occurrence date IS the due date. This used to add an offset of
    // `template.dueDate - template.createdAt`, which double-counted: the cursor is
    // now seeded from the template's own `dueDate` (see `normaliseRecurrence`), so
    // a template created a week before its due date produced a first occurrence due
    // a week after the date the user picked. It also went backwards for a template
    // whose due date preceded its creation, giving new tasks a due date in the past.
    // "Repeat weekly, due each Monday" is what a user means, and that is what
    // `occurrenceDate` already holds.
    const newDueDate = new Date(occurrenceDate);

    // `createdById` is a required ObjectId ref. The previous fallback wrote the
    // string 'system', which is not a valid ObjectId, so every template without
    // an owner threw a CastError here — AFTER the claim had already advanced the
    // cursor. That template therefore spawned nothing, forever, while its
    // `nextOccurrenceAt` kept marching forward and the only trace was one error
    // line per hour. Falling back to the template's creator is always valid,
    // because the template itself could not have been created without one.
    const actorId = ownerId ?? (template as any).createdById;
    if (!actorId) {
      throw new Error(
        `Template ${String(_id)} has neither ownerId nor createdById; cannot attribute the occurrence.`,
      );
    }

    try {
      await this.taskModel.create({
        tenantId,
        title,
        description,
        ownerId,
        categoryId,
        statusId,
        priority: priority ?? DEFAULT_TASK_PRIORITY,
        tags,
        relatedTo,
        reminderAt,
        dueDate: newDueDate,
        isRecurring: false,
        parentTaskId: _id,
        // Inherited so the occurrence lands in the same node of the org tree as
        // its template. Without it the child had no `orgUnitId` and was invisible
        // to every user whose data scope is org-unit based — the work existed and
        // the team responsible for it could not see it.
        orgUnitId: (template as any).orgUnitId ?? null,
        createdById: actorId,
        updatedById: actorId,
      });
    } catch (error) {
      // The claim already moved the cursor past this occurrence, so a failure
      // here loses it permanently unless we put the cursor back. Releasing it is
      // safe precisely because the claim is a compare-and-set: if another replica
      // has since advanced the template, our conditional update matches nothing
      // and we leave its work alone.
      await this.releaseOccurrence(String(_id), occurrenceDate, next, ended);
      throw error;
    }

    this.logger.log(
      `[RecurringTask] Spawned occurrence for "${title}" (template: ${String(_id)}). Next: ${ended ? 'ENDED' : next.toISOString()}`,
    );
  }

  /**
   * Undo a claim whose occurrence could not be created.
   *
   * Conditional on the template still holding the value this process wrote, so
   * two replicas cannot rewind each other. Without this, any transient failure
   * between claim and insert silently skipped one occurrence of a recurring task
   * — a missing weekly follow-up that nobody would think to look for.
   */
  private async releaseOccurrence(
    templateId: string,
    occurrenceDate: Date,
    next: Date,
    ended: boolean,
  ): Promise<void> {
    try {
      if (ended) {
        await this.taskModel.updateOne(
          { _id: templateId, isRecurring: false },
          { $set: { isRecurring: true, nextOccurrenceAt: occurrenceDate } },
        );
        return;
      }
      await this.taskModel.updateOne(
        { _id: templateId, nextOccurrenceAt: next },
        { $set: { nextOccurrenceAt: occurrenceDate } },
      );
    } catch (releaseError) {
      this.logger.error(
        `[RecurringTask] Could not release claim on template ${templateId}; ` +
          `occurrence ${occurrenceDate.toISOString()} is lost: ${
            releaseError instanceof Error
              ? releaseError.message
              : String(releaseError)
          }`,
      );
    }
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

  /**
   * Next occurrence date.
   *
   * Delegates to the domain helper so the scheduler and the create/update path
   * that seeds `nextOccurrenceAt` cannot disagree about what "every 2 weeks"
   * means — they used to be two independent switch statements.
   */
  private calculateNext(
    from: Date,
    rule: string | undefined,
    interval: number,
  ): Date {
    return advanceOccurrence(from, rule as TaskRecurrenceRule, interval);
  }
}
