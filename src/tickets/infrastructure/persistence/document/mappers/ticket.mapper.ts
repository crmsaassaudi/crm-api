import { Ticket } from '../../../../domain/ticket';
import { TicketSchemaClass } from '../entities/ticket.schema';

export class TicketMapper {
  static toDomain(raw: TicketSchemaClass): Ticket {
    const domainEntity = new Ticket();
    domainEntity.id = raw._id.toString();
    domainEntity.tenant = raw.tenant;
    domainEntity.ticketNumber = raw.ticketNumber;
    domainEntity.subject = raw.subject;
    domainEntity.description = raw.description ?? '';
    domainEntity.requester = raw.requester?.toString();
    domainEntity.assignee = raw.assignee?.toString();
    domainEntity.status = raw.status;
    domainEntity.priority = raw.priority;
    domainEntity.lifecycleStage = raw.lifecycleStage;
    domainEntity.channel = raw.channel;
    domainEntity.source = raw.source;
    domainEntity.relatedTo = raw.relatedTo;
    domainEntity.slaBreached = raw.slaBreached;
    domainEntity.tags = raw.tags;
    domainEntity.customFields = raw.customFields;
    domainEntity.resolvedAt = raw.resolvedAt;
    domainEntity.closedAt = raw.closedAt;
    domainEntity.createdAt = raw.createdAt;
    domainEntity.updatedAt = raw.updatedAt;
    domainEntity.deletedAt = raw.deletedAt;
    return domainEntity;
  }

  static toPersistence(domainEntity: Ticket): TicketSchemaClass {
    const persistenceEntity = new TicketSchemaClass();
    if (domainEntity.id) {
      persistenceEntity._id = domainEntity.id;
    }
    persistenceEntity.tenant = domainEntity.tenant;
    persistenceEntity.ticketNumber = domainEntity.ticketNumber;
    persistenceEntity.subject = domainEntity.subject;
    persistenceEntity.description = domainEntity.description;
    persistenceEntity.requester = domainEntity.requester;
    persistenceEntity.assignee = domainEntity.assignee;
    persistenceEntity.status = domainEntity.status;
    persistenceEntity.priority = domainEntity.priority;
    persistenceEntity.lifecycleStage = domainEntity.lifecycleStage;
    persistenceEntity.channel = domainEntity.channel;
    persistenceEntity.source = domainEntity.source;
    persistenceEntity.relatedTo = domainEntity.relatedTo;
    persistenceEntity.slaBreached = domainEntity.slaBreached;
    persistenceEntity.tags = domainEntity.tags;
    persistenceEntity.customFields = domainEntity.customFields;
    persistenceEntity.resolvedAt = domainEntity.resolvedAt;
    persistenceEntity.closedAt = domainEntity.closedAt;
    return persistenceEntity;
  }
}
