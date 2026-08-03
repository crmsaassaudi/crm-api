import { Task } from '../../../../domain/task';
import { TaskSchemaClass } from '../entities/task.schema';

/**
 * Domain ↔ persistence translation for tasks.
 *
 * `toPersistence` is not merely a converter — `BaseDocumentRepository.update`
 * intersects its output with the payload keys to build `$set`, so **a field this
 * method omits can never be written by an update**. Everything the schema
 * declares and a caller may legitimately change therefore has to appear below.
 * The omissions this replaced were invisible from the outside: PATCHing
 * `orgUnitId`, any recurrence field, or `updatedById` returned 200 with the old
 * value still in the database.
 */
export class TaskMapper {
  static toDomain(raw: TaskSchemaClass): Task {
    const domainEntity = new Task();
    domainEntity.id = raw._id.toString();
    domainEntity.tenantId = raw.tenantId?.toString();
    domainEntity.title = raw.title;
    domainEntity.description = raw.description;
    domainEntity.dueDate = raw.dueDate;
    domainEntity.statusId = raw.statusId?.toString();
    domainEntity.priority = raw.priority;
    domainEntity.categoryId = raw.categoryId?.toString();
    domainEntity.ownerId = raw.ownerId?.toString();
    domainEntity.orgUnitId = raw.orgUnitId?.toString() ?? null;
    if (raw.relatedTo) {
      domainEntity.relatedTo = {
        type: raw.relatedTo.type,
        id:
          raw.relatedTo._id?.toString() ||
          (raw.relatedTo as any).id?.toString(),
        name: raw.relatedTo.name,
      };
    }
    domainEntity.tags = raw.tags;
    domainEntity.reminderAt = raw.reminderAt;
    domainEntity.reminderSentAt = raw.reminderSentAt ?? null;
    domainEntity.completedAt = raw.completedAt;
    domainEntity.sourceId = raw.sourceId?.toString();
    domainEntity.customFields = raw.customFields;

    domainEntity.isRecurring = raw.isRecurring;
    domainEntity.recurrenceRule = raw.recurrenceRule;
    domainEntity.recurrenceInterval = raw.recurrenceInterval;
    domainEntity.recurrenceEndsAt = raw.recurrenceEndsAt ?? null;
    domainEntity.nextOccurrenceAt = raw.nextOccurrenceAt ?? null;
    domainEntity.parentTaskId = raw.parentTaskId?.toString() ?? null;

    domainEntity.createdById = raw.createdById?.toString();
    domainEntity.updatedById = raw.updatedById?.toString();

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
    domainEntity.version = (raw as any).__v;
    return domainEntity;
  }

  static toPersistence(domainEntity: Task): TaskSchemaClass {
    const persistenceEntity = new TaskSchemaClass();
    if (domainEntity.id) {
      persistenceEntity._id = domainEntity.id;
    }
    // Carried so `updateIfExists` can turn it into a compare-and-set predicate.
    // It goes into the query filter, never into `$set` — the repository deletes
    // it from the payload before building the update.
    if (domainEntity.version !== undefined) {
      (persistenceEntity as any).__v = domainEntity.version;
    }
    persistenceEntity.tenantId = domainEntity.tenantId;
    persistenceEntity.title = domainEntity.title;
    persistenceEntity.description = domainEntity.description;
    persistenceEntity.dueDate = domainEntity.dueDate;
    persistenceEntity.statusId = domainEntity.statusId;
    persistenceEntity.priority = domainEntity.priority;
    persistenceEntity.categoryId = domainEntity.categoryId;
    persistenceEntity.ownerId = domainEntity.ownerId;
    persistenceEntity.orgUnitId = domainEntity.orgUnitId;
    if (domainEntity.relatedTo) {
      persistenceEntity.relatedTo = {
        type: domainEntity.relatedTo.type,
        _id: domainEntity.relatedTo.id || (domainEntity.relatedTo as any)._id,
        name: domainEntity.relatedTo.name,
      };
    }
    persistenceEntity.tags = domainEntity.tags;
    persistenceEntity.reminderAt = domainEntity.reminderAt;
    persistenceEntity.reminderSentAt = domainEntity.reminderSentAt;
    persistenceEntity.completedAt = domainEntity.completedAt;
    persistenceEntity.sourceId = domainEntity.sourceId;
    persistenceEntity.customFields = domainEntity.customFields;

    persistenceEntity.isRecurring = domainEntity.isRecurring;
    persistenceEntity.recurrenceRule = domainEntity.recurrenceRule;
    persistenceEntity.recurrenceInterval = domainEntity.recurrenceInterval;
    persistenceEntity.recurrenceEndsAt = domainEntity.recurrenceEndsAt;
    persistenceEntity.nextOccurrenceAt = domainEntity.nextOccurrenceAt;
    persistenceEntity.parentTaskId = domainEntity.parentTaskId;

    // `updatedById` is the reason attribution was wrong for every task in the
    // database. The base repository whitelists the key explicitly so a PATCH may
    // always write it, then builds `$set` by iterating what THIS method returns —
    // and it was not returned. Result: `updatedAt` advanced on every edit while
    // `updatedById` stayed frozen at whoever created the record, so the UI showed
    // a correct timestamp next to the wrong name.
    // Cast because the schema types these as required (they are, on a stored
    // document) while a partial update legitimately carries neither. The base
    // repository drops undefined values before building `$set`, so an absent key
    // never reaches Mongo as an unset.
    persistenceEntity.updatedById = domainEntity.updatedById as string;
    if (domainEntity.createdById) {
      persistenceEntity.createdById = domainEntity.createdById;
    }
    return persistenceEntity;
  }
}
