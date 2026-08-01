import { Injectable, NotFoundException, Optional } from '@nestjs/common';
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
import { TASK_EXPORT_QUEUE } from './tasks.constants';

@Injectable()
export class TasksService {
  constructor(
    private readonly repository: TaskRepository,
    private readonly entityAudit: EntityAuditService,
    private readonly cls: ClsService,
    private readonly automationOutbox: AutomationOutboxService,
    @InjectQueue(TASK_EXPORT_QUEUE)
    private readonly exportQueue: Queue,
    private readonly exportRequest: ExportRequestService,
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
    const ownerId = data.ownerId === '' ? undefined : data.ownerId;
    const customFields = this.customFieldValidator
      ? await this.customFieldValidator.validate('Task', data.customFields, {
          strict: true,
        })
      : data.customFields;

    const task = await this.automationOutbox.runWithEvent(
      (session) =>
        this.repository.create(
          {
            ...data,
            ownerId,
            statusId: data.statusId,
            categoryId: data.categoryId,
            customFields,
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

  async findAll(filter: any): Promise<any> {
    const filterOptions = {
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
        page: Number(filter.page) || 1,
        limit: Number(filter.limit) || 10,
      },
    });
  }

  async findOne(id: string): Promise<Task | null> {
    return this.repository.findOne({ _id: id });
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
    const ownerId = data.ownerId === '' ? undefined : data.ownerId;

    const customFields = this.customFieldValidator
      ? await this.customFieldValidator.validate('Task', data.customFields, {
          partial: true,
          strict: true,
        })
      : data.customFields;
    const updateData: any = {
      ...data,
      ownerId,
      ...(customFields !== undefined ? { customFields } : {}),
    };

    // Auto-set completedAt when task is marked with a terminal status
    // The frontend should send completedAt when appropriate
    if (
      data.completedAt === undefined &&
      updateData.completedAt === undefined
    ) {
      // no-op: let the frontend decide
    }

    const changedFields = Object.keys(data).filter((k) => k !== 'updatedBy');
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

  // ──────────────────────── RECYCLE BIN ────────────────────────
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
    const restored = await this.repository.restore(id);
    if (!restored) {
      throw new NotFoundException(
        'Task not found in the recycle bin — it may already have been purged',
      );
    }

    this.entityAudit.emit({
      entity: 'task',
      entityType: 'TASK',
      entityId: id,
      kind: 'updated',
      oldSnapshot: { _deleted: true } as any,
      newSnapshot: restored,
    });

    return restored;
  }

  async remove(id: string): Promise<void> {
    const existing = await this.repository.findOne({ _id: id });
    await this.repository.remove(id);
    this.entityAudit.emit({
      entity: 'task',
      entityType: 'TASK',
      entityId: id,
      kind: 'updated',
      oldSnapshot: existing ?? {},
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
