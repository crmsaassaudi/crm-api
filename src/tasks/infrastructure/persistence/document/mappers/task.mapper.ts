import { Task } from '../../../../domain/task';
import { TaskSchemaClass } from '../entities/task.schema';

export class TaskMapper {
  static toDomain(raw: TaskSchemaClass): Task {
    const domainEntity = new Task();
    domainEntity.id = raw._id.toString();
    domainEntity.tenant = raw.tenant;
    domainEntity.title = raw.title;
    domainEntity.description = raw.description;
    domainEntity.dueDate = raw.dueDate;
    domainEntity.status = raw.status;
    domainEntity.priority = raw.priority;
    domainEntity.category = raw.category;
    domainEntity.assignedTo = raw.assignedTo?.toString();
    domainEntity.relatedTo = raw.relatedTo;
    domainEntity.tags = raw.tags;
    domainEntity.reminderAt = raw.reminderAt;
    domainEntity.completedAt = raw.completedAt;
    domainEntity.source = raw.source;
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
    persistenceEntity.tenant = domainEntity.tenant;
    persistenceEntity.title = domainEntity.title;
    persistenceEntity.description = domainEntity.description;
    persistenceEntity.dueDate = domainEntity.dueDate;
    persistenceEntity.status = domainEntity.status;
    persistenceEntity.priority = domainEntity.priority;
    persistenceEntity.category = domainEntity.category;
    persistenceEntity.assignedTo = domainEntity.assignedTo;
    persistenceEntity.relatedTo = domainEntity.relatedTo;
    persistenceEntity.tags = domainEntity.tags;
    persistenceEntity.reminderAt = domainEntity.reminderAt;
    persistenceEntity.completedAt = domainEntity.completedAt;
    persistenceEntity.source = domainEntity.source;
    return persistenceEntity;
  }
}
