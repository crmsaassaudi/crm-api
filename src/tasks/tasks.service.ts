import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { AutomationEventPayload } from '../automation-rules/events/automation-event.payload';
import { AutomationOutboxService } from '../automation-rules/events/automation-outbox.service';
import { TaskRepository } from './infrastructure/persistence/document/repositories/task.repository';
import { Task } from './domain/task';
import { EntityAuditService } from '../common/audit/entity-audit.service';

@Injectable()
export class TasksService {
  constructor(
    private readonly repository: TaskRepository,
    private readonly entityAudit: EntityAuditService,
    private readonly cls: ClsService,
    private readonly automationOutbox: AutomationOutboxService,
  ) {}

  async create(data: Partial<Task>): Promise<Task> {
    const ownerId = data.ownerId === '' ? undefined : data.ownerId;

    const task = await this.automationOutbox.runWithEvent(
      (session) =>
        this.repository.create(
          {
            ...data,
            ownerId,
            statusId: data.statusId,
            categoryId: data.categoryId,
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
    return this.repository.findManyWithPagination({
      filterOptions: filter,
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
    const ownerId = data.ownerId === '' ? undefined : data.ownerId;

    const updateData: any = { ...data, ownerId };

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
