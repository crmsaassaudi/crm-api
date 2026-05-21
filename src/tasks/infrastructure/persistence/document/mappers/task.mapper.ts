import { Task } from '../../../../domain/task';
import { TaskSchemaClass } from '../entities/task.schema';

export class TaskMapper {
  static toDomain(raw: TaskSchemaClass): Task {
    const domainEntity = new Task();
    domainEntity.id = raw._id.toString();
    domainEntity.tenantId = raw.tenantId;
    domainEntity.title = raw.title;
    domainEntity.description = raw.description;
    domainEntity.dueDate = raw.dueDate;
    domainEntity.statusId = raw.statusId?.toString();
    domainEntity.priority = raw.priority;
    domainEntity.categoryId = raw.categoryId?.toString();
    domainEntity.ownerId = raw.ownerId?.toString();
    if (raw.relatedTo) {
      domainEntity.relatedTo = {
        type: raw.relatedTo.type,
        id: raw.relatedTo._id?.toString() || (raw.relatedTo as any).id?.toString(),
        name: raw.relatedTo.name,
      };
    }
    domainEntity.tags = raw.tags;
    domainEntity.reminderAt = raw.reminderAt;
    domainEntity.completedAt = raw.completedAt;
    domainEntity.sourceId = raw.sourceId?.toString();
    if ((raw as any).taskStatus) {
      const s = (raw as any).taskStatus;
      domainEntity.taskStatus = {
        id: s._id?.toString(),
        label: s.label,
        apiName: s.apiName,
        color: s.color,
        isTerminal: s.isTerminal,
      };
    }
    if ((raw as any).taskCategory) {
      const s = (raw as any).taskCategory;
      domainEntity.taskCategory = {
        id: s._id?.toString(),
        name: s.name,
        apiName: s.apiName,
      };
    }
    if ((raw as any).taskSource) {
      const s = (raw as any).taskSource;
      domainEntity.taskSource = { id: s._id?.toString(), name: s.name };
    }
    domainEntity.createdAt = raw.createdAt;
    domainEntity.updatedAt = raw.updatedAt;
    domainEntity.deletedAt = raw.deletedAt;
    return domainEntity;
  }

  static toPersistence(domainEntity: Task): TaskSchemaClass {
    const persistenceEntity = new TaskSchemaClass();
    if (domainEntity.id) {
      persistenceEntity._id = domainEntity.id;
    }
    persistenceEntity.tenantId = domainEntity.tenantId;
    persistenceEntity.title = domainEntity.title;
    persistenceEntity.description = domainEntity.description;
    persistenceEntity.dueDate = domainEntity.dueDate;
    persistenceEntity.statusId = domainEntity.statusId;
    persistenceEntity.priority = domainEntity.priority;
    persistenceEntity.categoryId = domainEntity.categoryId;
    persistenceEntity.ownerId = domainEntity.ownerId;
    if (domainEntity.relatedTo) {
      persistenceEntity.relatedTo = {
        type: domainEntity.relatedTo.type,
        _id: domainEntity.relatedTo.id || (domainEntity.relatedTo as any)._id,
        name: domainEntity.relatedTo.name,
      };
    }
    persistenceEntity.tags = domainEntity.tags;
    persistenceEntity.reminderAt = domainEntity.reminderAt;
    persistenceEntity.completedAt = domainEntity.completedAt;
    persistenceEntity.sourceId = domainEntity.sourceId;
    return persistenceEntity;
  }
}
