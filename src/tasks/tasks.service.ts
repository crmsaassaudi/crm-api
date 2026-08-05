import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { AutomationEventPayload } from '../automation-rules/events/automation-event.payload';
import { AutomationOutboxService } from '../automation-rules/events/automation-outbox.service';
import { TaskRepository } from './infrastructure/persistence/document/repositories/task.repository';
import { Task } from './domain/task';
import { EntityAuditService } from '../common/audit/entity-audit.service';
import { CustomFieldsService } from '../custom-fields/custom-fields.service';
import { loadCustomFieldDefinitions } from '../utils/custom-field-filter';
import { CustomFieldValueValidator } from '../custom-fields/custom-field-value.validator';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { ExportRequestDto, ExportRequestService } from '../common/export';
import {
  TASK_EXPORT_QUEUE,
  TASK_LIST_DEFAULT_LIMIT,
  TASK_LIST_MAX_LIMIT,
} from './tasks.constants';
import { TaskListFilter } from './dto/task-list-query.dto';
import { PaginationResponseDto } from '../utils/dto/pagination-response.dto';
import {
  applyLifecycle,
  assertTerminalEditAllowed,
  TaskLifecycleViolation,
} from './domain/task-lifecycle';
import { TaskReferenceValidator } from './task-reference.validator';
import {
  normaliseRecurrence,
  TaskRecurrenceViolation,
} from './domain/task-recurrence';
import { RecordWriteValidator } from '../object-manager/validation/record-write-validator.service';
import { BulkTaskResult, BulkUpdateTasksDto } from './dto/bulk-task.dto';

@Injectable()
export class TasksService {
  private readonly logger = new Logger(TasksService.name);

  constructor(
    private readonly repository: TaskRepository,
    private readonly entityAudit: EntityAuditService,
    private readonly cls: ClsService,
    private readonly automationOutbox: AutomationOutboxService,
    @InjectQueue(TASK_EXPORT_QUEUE)
    private readonly exportQueue: Queue,
    private readonly exportRequest: ExportRequestService,
    private readonly references: TaskReferenceValidator,
    // Not @Optional: the tenant's required-field and validation rules are part of
    // what a write means, so a container that cannot supply them should fail at
    // boot rather than accept records that skipped them.
    private readonly writeValidator: RecordWriteValidator,
    @Optional() private readonly customFields?: CustomFieldsService,
    @Optional()
    private readonly customFieldValidator?: CustomFieldValueValidator,
  ) {}

  async exportTasks(
    dto: ExportRequestDto,
  ): Promise<{ jobId: string; status: 'queued' }> {
    const querySnapshot = {
      filters: dto.filters ?? [],
      search: dto.search,
    };
    return this.exportRequest.enqueue({
      entityType: 'task',
      queue: this.exportQueue,
      format: dto.format,
      ids: dto.ids,
      columns: dto.columns,
      legacyFilters: {
        ...querySnapshot,
        __customFieldDefinitions: await loadCustomFieldDefinitions(
          this.customFields,
          'Task',
          dto.filters,
        ),
      },
      filterSnapshot: { ids: dto.ids, ...querySnapshot },
    });
  }

  getExportStatus(jobId: string) {
    return this.exportRequest.status(this.exportQueue, jobId);
  }

  cancelExport(jobId: string) {
    return this.exportRequest.cancel('task', jobId);
  }

  listExportJobs(options: { page?: number; limit?: number; status?: string }) {
    return this.exportRequest.list('task', this.exportQueue, options);
  }

  getExportDownload(token: string) {
    return this.exportRequest.download('tasks', token);
  }

  async create(data: Partial<Task>): Promise<Task> {
    await this.writeValidator.assertValid(
      'Task',
      data as unknown as Record<string, unknown>,
      'create',
    );
    const ownerId = data.ownerId === '' ? undefined : data.ownerId;
    const customFields = this.customFieldValidator
      ? await this.customFieldValidator.validate('Task', data.customFields, {
          strict: true,
        })
      : data.customFields;

    // Every id in the payload is confirmed to exist inside this tenant before
    // anything is written. Without it the owner could be any ObjectId at all,
    // which produced a task nobody in the org could see.
    const { statuses } = await this.references.resolve({
      ownerId,
      statusId: data.statusId,
      categoryId: data.categoryId,
      sourceId: data.sourceId,
    });

    const effects = this.applyLifecycleOrReject(
      {},
      { ...data, ownerId },
      statuses,
    );
    const recurrence = this.normaliseRecurrenceOrReject({}, data);

    const task = await this.automationOutbox.runWithEvent(
      (session) =>
        this.repository.create(
          {
            ...data,
            ownerId,
            statusId: data.statusId,
            categoryId: data.categoryId,
            customFields,
            ...effects,
            ...recurrence,
          } as any,
          session,
        ),
      (created) => this.buildAutomationEvent('record_created', created),
    );

    this.entityAudit.emit({
      entity: 'task',
      entityType: 'TASK',
      entityId: task.id,
      kind: 'created',
      newSnapshot: task,
    });

    return task;
  }

  async findAll(filter: TaskListFilter): Promise<PaginationResponseDto<Task>> {
    const filterOptions: TaskListFilter = {
      ...filter,
      __customFieldDefinitions: await loadCustomFieldDefinitions(
        this.customFields,
        'Task',
        filter.filters,
      ),
    };
    return this.repository.findManyWithPagination({
      filterOptions,
      paginationOptions: {
        page: Math.max(1, Number(filter.page) || 1),
        // Clamped here as well as in the DTO. The DTO covers the HTTP surface,
        // but `ContactsController.getTasks` reaches this method with its own
        // `SubResourceQueryDto`, and a future internal caller has no DTO at all
        // — so the invariant "no caller can ask for an unbounded page" belongs
        // where every caller passes through.
        limit: Math.min(
          TASK_LIST_MAX_LIMIT,
          Math.max(1, Number(filter.limit) || TASK_LIST_DEFAULT_LIMIT),
        ),
      },
    });
  }

  /**
   * 404 rather than `200 null`.
   *
   * The handler used to return whatever this produced, so fetching a
   * soft-deleted task — which `repository.findOne` correctly filters out —
   * answered `200` with a `null` body. A client cannot tell that apart from a
   * task with no fields.
   */
  async findOne(id: string): Promise<Task> {
    const task = await this.repository.findOne({ _id: id });
    if (!task) {
      throw new NotFoundException(`Task ${id} not found`);
    }
    return task;
  }

  async update(id: string, data: Partial<Task>): Promise<Task | null> {
    const existing = await this.repository.findOne({ _id: id });
    // `findOne` is scoped by tenant, data-visibility and the ABAC deny, so a
    // miss means "not yours to edit". Refusing here rather than letting the
    // write miss keeps the answer a 404 and skips the validation work a denied
    // request should never pay for.
    if (!existing) {
      throw new NotFoundException(`Task ${id} not found`);
    }
    await this.writeValidator.assertValid(
      'Task',
      data as unknown as Record<string, unknown>,
      'update',
    );
    const ownerId = data.ownerId === '' ? undefined : data.ownerId;

    const customFields = this.customFieldValidator
      ? await this.customFieldValidator.validate('Task', data.customFields, {
          partial: true,
          strict: true,
        })
      : data.customFields;

    const { statuses } = await this.references.resolve({
      ownerId,
      statusId: data.statusId,
      categoryId: data.categoryId,
      sourceId: data.sourceId,
    });

    // A finished task may be corrected but not silently rescheduled or
    // reassigned while it stays finished — those are the fields reports read.
    //
    // Wrapped in the same translation as the lifecycle rules. Left unwrapped, this
    // domain error escaped as a 500 for what is a plain 422 — the refusal was
    // correct and the status code told the client the server had broken.
    this.rejectAsUnprocessable(() =>
      assertTerminalEditAllowed(existing, { ...data, ownerId }, statuses),
    );

    const effects = this.applyLifecycleOrReject(
      existing,
      { ...data, ownerId },
      statuses,
    );

    const recurrence = this.normaliseRecurrenceOrReject(existing, data);

    const updateData: any = {
      ...data,
      ownerId,
      ...(customFields !== undefined ? { customFields } : {}),
      ...effects,
      ...recurrence,
      // The revision to write against. A client that sent one gets true
      // optimistic locking — a stale value means someone else has written since
      // the form was rendered, and the base repository answers 409. A client
      // that sent nothing falls back to the revision just read, which still
      // closes the window between this read and the write below.
      version: data.version ?? existing.version,
    };

    const changedFields = Object.keys(data).filter(
      (key) => key !== 'updatedBy' && key !== 'version',
    );
    const updated = await this.automationOutbox.runWithEvent(
      (session) => this.repository.update(id, updateData, session),
      (result) =>
        result
          ? this.buildAutomationEvent('field_updated', result, changedFields)
          : null,
    );

    if (updated) {
      this.entityAudit.emit({
        entity: 'task',
        entityType: 'TASK',
        entityId: id,
        kind: 'updated',
        oldSnapshot: existing ?? {},
        newSnapshot: updated,
      });
    }

    return updated;
  }

  /**
   * Run the lifecycle rules and translate a domain violation into HTTP 422.
   *
   * The rules live in `domain/task-lifecycle.ts` and know nothing about Nest, so
   * the mapping has to happen somewhere; doing it here keeps the domain testable
   * without a framework and keeps the wire format identical to the global
   * ValidationPipe's.
   */
  private applyLifecycleOrReject(
    current: Partial<Task>,
    change: Partial<Task>,
    statuses: ReadonlyMap<string, { isTerminal: boolean }>,
  ) {
    return this.rejectAsUnprocessable(() =>
      applyLifecycle(current, change, statuses),
    );
  }

  /**
   * Run a domain rule and turn its refusal into HTTP 422.
   *
   * The domain modules throw their own error types precisely so they can be tested
   * without Nest; that makes translating them the service's job, and *every* call
   * site's job. One unwrapped call was enough to turn a valid refusal into a 500.
   */
  private rejectAsUnprocessable<T>(run: () => T): T {
    try {
      return run();
    } catch (error) {
      if (
        error instanceof TaskLifecycleViolation ||
        error instanceof TaskRecurrenceViolation
      ) {
        throw new UnprocessableEntityException({
          status: 422,
          errors: { [error.field]: error.message },
        });
      }
      throw error;
    }
  }

  /**
   * Seed or clear the recurrence cursor, translating a domain refusal into 422.
   *
   * Without this, `isRecurring: true` reached the database with
   * `nextOccurrenceAt` unset, and the scheduler — which selects on that field —
   * never saw the template.
   */
  private normaliseRecurrenceOrReject(
    current: Partial<Task>,
    change: Partial<Task>,
  ) {
    try {
      return normaliseRecurrence(current, change);
    } catch (error) {
      if (error instanceof TaskRecurrenceViolation) {
        throw new UnprocessableEntityException({
          status: 422,
          errors: { [error.field]: error.message },
        });
      }
      throw error;
    }
  }

  // BULK OPERATIONS
  //
  // The module had none, so a manager retriaging fifty tasks issued fifty PATCHes
  // and a tenant with 10.000 users had no way to act at the scale it works at.
  //
  // Both methods below deliberately loop over `update()` / `remove()` rather than
  // issuing one `bulkWrite`. A single `bulkWrite` would be fewer round-trips and
  // would bypass every guarantee the single-record path has: the visibility scope
  // check, the lifecycle rules, the audit entry per record and the automation
  // event per record. "Fast but unaudited and unvalidated" is not a bulk version
  // of this operation, it is a different operation. The id cap is what keeps the
  // loop bounded.

  async bulkUpdate(dto: BulkUpdateTasksDto): Promise<BulkTaskResult> {
    const { ids, ...changes } = dto;
    const result: BulkTaskResult = { updated: 0, skipped: [] };

    if (Object.keys(changes).length === 0) {
      throw new UnprocessableEntityException({
        status: 422,
        errors: { changes: 'Cần ít nhất một trường để cập nhật.' },
      });
    }

    for (const id of ids) {
      try {
        await this.update(id, changes as Partial<Task>);
        result.updated++;
      } catch (error) {
        result.skipped.push({ id, reason: this.describeSkip(error) });
      }
    }

    return result;
  }

  async bulkRemove(ids: string[]): Promise<BulkTaskResult> {
    const result: BulkTaskResult = { updated: 0, skipped: [] };

    for (const id of ids) {
      try {
        await this.remove(id);
        result.updated++;
      } catch (error) {
        result.skipped.push({ id, reason: this.describeSkip(error) });
      }
    }

    return result;
  }

  /**
   * Why one id in a bulk operation was not applied.
   *
   * A 404 is reported as a scope miss rather than as "not found", because from the
   * caller's side those are the same fact and the distinction is exactly what a
   * scoped user is not entitled to learn.
   */
  private describeSkip(error: unknown): string {
    if (error instanceof NotFoundException) {
      return 'Không tồn tại hoặc ngoài phạm vi truy cập.';
    }
    if (error instanceof ConflictException) {
      return 'Đã bị người khác thay đổi; hãy tải lại.';
    }
    if (error instanceof UnprocessableEntityException) {
      const response = error.getResponse() as {
        errors?: Record<string, string>;
      };
      const first = response?.errors
        ? Object.values(response.errors)[0]
        : undefined;
      return first ?? 'Không hợp lệ.';
    }
    // Anything else is a real fault, not a per-record outcome, so it is logged
    // rather than folded into a tidy summary.
    this.logger.error(
      `Bulk task operation failed unexpectedly: ${
        error instanceof Error ? error.message : String(error)
      }`,
      error instanceof Error ? error.stack : undefined,
    );
    return 'Lỗi không xác định.';
  }

  // RECYCLE BIN
  //
  // `remove()` is a soft delete (the schema declares `deletedAt`), so without these
  // two methods a deleted task was invisible everywhere and recoverable nowhere —
  // strictly worse than the hard delete it replaced, because the row also stayed in
  // the database forever.

  async listDeleted(options: { page?: number; limit?: number }): Promise<{
    data: Task[];
    total: number;
    page: number;
    limit: number;
  }> {
    const page = Math.max(1, options.page ?? 1);
    const limit = Math.min(100, Math.max(1, options.limit ?? 25));
    const { data, total } = await this.repository.findDeleted({ page, limit });
    return { data, total, page, limit };
  }

  async restore(id: string): Promise<Task> {
    const restored = await this.automationOutbox.runWithEvent(
      (session) => this.repository.restore(id, session),
      // A restore is a change to `deletedAt`, so it reaches workflows through the
      // `field_updated` trigger they already have. The automation engine has no
      // `record_deleted` event type — inventing one here would mean a new trigger
      // kind in the workflow DTO, the evaluator and the builder UI, for a
      // transition the existing vocabulary already describes exactly.
      (result) =>
        result
          ? this.buildAutomationEvent('field_updated', result, ['deletedAt'])
          : null,
    );

    if (!restored) {
      throw new NotFoundException(
        'Task not found in the recycle bin — it may already have been purged',
      );
    }

    this.entityAudit.emit({
      entity: 'task',
      entityType: 'TASK',
      entityId: id,
      // 'restored', not 'updated'. `AuditEventKind` has had the precise kinds all
      // along; recording a restore as a generic update meant no audit query could
      // answer "was this task ever in the recycle bin, and who brought it back".
      kind: 'restored',
      oldSnapshot: { _deleted: true } as any,
      newSnapshot: restored,
    });

    return restored;
  }

  async remove(id: string): Promise<void> {
    const existing = await this.repository.findOne({ _id: id });
    // Refuse before writing, so a caller who cannot see the task is told 404
    // rather than receiving 204 for a delete that never happened.
    if (!existing) {
      throw new NotFoundException(`Task ${id} not found`);
    }

    await this.automationOutbox.runWithEvent(
      async (session) => {
        await this.repository.remove(id, session);
        return { ...existing, deletedAt: new Date() } as Task;
      },
      (result) =>
        this.buildAutomationEvent('field_updated', result, ['deletedAt']),
    );

    this.entityAudit.emit({
      entity: 'task',
      entityType: 'TASK',
      entityId: id,
      // 'deleted', not 'updated'. The old value made "who deleted this task"
      // unanswerable from the audit log — the only trace was a snapshot with a
      // synthetic `_deleted` flag that no query filtered on.
      kind: 'deleted',
      oldSnapshot: existing,
      newSnapshot: { _deleted: true } as any,
    });
  }

  /**
   * Notify the Automation Engine after a successful write.
   *
   * Task triggers were selectable in the workflow builder but this service never
   * emitted the event, so `record_created.Task` and `field_updated.Task`
   * workflows could be authored, published and activated without ever firing.
   * AutomationEventPayload's own docblock claimed this service was an emitter.
   */
  private buildAutomationEvent(
    event: 'record_created' | 'field_updated',
    record: Task,
    changedFields?: string[],
  ): AutomationEventPayload | null {
    const tenantId = this.cls.get('activeTenantId') ?? this.cls.get('tenantId');
    if (!tenantId) {
      throw new Error('Tenant context is required for Task automation.');
    }

    const payload: AutomationEventPayload = {
      tenantId,
      event,
      object: 'Task',
      recordId: record.id,
      data: record as any,
      ...(changedFields ? { changedFields } : {}),
      automationDepth: 0,
      // Feeds `runAs: 'trigger_user'`. Read from CLS at emit time because the
      // queue worker that evaluates this event has no request to read it from.
      triggerUserId: this.cls.get('userId') ?? null,
    };

    return payload;
  }
}
