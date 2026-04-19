import { Ticket } from '../../../../domain/ticket';
import { TicketSchemaClass } from '../entities/ticket.schema';
import { UserMapper } from '../../../../../users/infrastructure/persistence/document/mappers/user.mapper';

export class TicketMapper {
  static toDomain(raw: TicketSchemaClass): Ticket {
    const domainEntity = new Ticket();
    domainEntity.id = raw._id.toString();
    domainEntity.tenantId = raw.tenantId;
    domainEntity.ticketNumber = raw.ticketNumber;
    domainEntity.subject = raw.subject;
    domainEntity.description = raw.description ?? '';
    domainEntity.requesterId = raw.requesterId?.toString();
    domainEntity.assigneeId = raw.assigneeId?.toString();
    domainEntity.ownerId = raw.ownerId?.toString();
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

    if ((raw as any).owner) {
      domainEntity.owner = UserMapper.toDomain((raw as any).owner);
    }

    return domainEntity;
  }

  static toPersistence(domainEntity: Ticket): TicketSchemaClass {
    const persistenceEntity = new TicketSchemaClass();
    if (domainEntity.id) {
      persistenceEntity._id = domainEntity.id;
    }
    persistenceEntity.tenantId = domainEntity.tenantId;
    persistenceEntity.ticketNumber = domainEntity.ticketNumber;
    persistenceEntity.subject = domainEntity.subject;
    persistenceEntity.description = domainEntity.description;
    persistenceEntity.requesterId = domainEntity.requesterId;
    persistenceEntity.assigneeId = domainEntity.assigneeId;
    persistenceEntity.ownerId = domainEntity.ownerId;
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
