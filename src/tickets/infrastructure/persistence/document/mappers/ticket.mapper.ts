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

    // Customer Context
    domainEntity.contactId = raw.contactId?.toString();
    domainEntity.accountId = raw.accountId?.toString();
    domainEntity.omniConversationId = raw.omniConversationId?.toString();
    domainEntity.linkedMessageIds = raw.linkedMessageIds;
    domainEntity.relatedTo = raw.relatedTo;

    // Classification & Routing
    domainEntity.type = raw.type;
    domainEntity.category = raw.category;
    domainEntity.subCategory = raw.subCategory;
    domainEntity.priority = raw.priority;
    domainEntity.channel = raw.channel;
    domainEntity.source = raw.source;
    domainEntity.tags = raw.tags;
    domainEntity.customFields = raw.customFields;

    // Assignment & Collaboration
    domainEntity.groupId = raw.groupId?.toString();
    domainEntity.ownerId = raw.ownerId?.toString();
    domainEntity.watchers = raw.watchers?.map((w) => w.toString());
    domainEntity.status = raw.status;

    // SLA Management
    domainEntity.slaPolicyId = raw.slaPolicyId?.toString();
    domainEntity.firstResponseDueAt = raw.firstResponseDueAt;
    domainEntity.resolutionDueAt = raw.resolutionDueAt;
    domainEntity.isSlaBreached = raw.isSlaBreached ?? false;

    // Metrics & Resolution
    domainEntity.resolutionCode = raw.resolutionCode;
    domainEntity.resolutionNotes = raw.resolutionNotes;
    domainEntity.csatScore = raw.csatScore;
    domainEntity.timeSpentSeconds = raw.timeSpentSeconds;

    // Timestamps
    domainEntity.firstRespondedAt = raw.firstRespondedAt;
    domainEntity.resolvedAt = raw.resolvedAt;
    domainEntity.closedAt = raw.closedAt;
    domainEntity.createdAt = raw.createdAt;
    domainEntity.updatedAt = raw.updatedAt;
    domainEntity.deletedAt = raw.deletedAt;

    // Populated virtuals
    if ((raw as any).owner) {
      domainEntity.owner = UserMapper.toDomain((raw as any).owner);
    }
    if ((raw as any).group) {
      const g = (raw as any).group;
      domainEntity.group = {
        id: g._id?.toString(),
        name: g.name,
      };
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

    // Customer Context
    persistenceEntity.contactId = domainEntity.contactId;
    persistenceEntity.accountId = domainEntity.accountId;
    persistenceEntity.omniConversationId = domainEntity.omniConversationId;
    persistenceEntity.linkedMessageIds = domainEntity.linkedMessageIds;
    persistenceEntity.relatedTo = domainEntity.relatedTo;

    // Classification & Routing
    persistenceEntity.type = domainEntity.type;
    persistenceEntity.category = domainEntity.category;
    persistenceEntity.subCategory = domainEntity.subCategory;
    persistenceEntity.priority = domainEntity.priority;
    persistenceEntity.channel = domainEntity.channel;
    persistenceEntity.source = domainEntity.source;
    persistenceEntity.tags = domainEntity.tags;
    persistenceEntity.customFields = domainEntity.customFields;

    // Assignment & Collaboration
    persistenceEntity.groupId = domainEntity.groupId;
    persistenceEntity.ownerId = domainEntity.ownerId;
    persistenceEntity.watchers = domainEntity.watchers;
    persistenceEntity.status = domainEntity.status;

    // SLA Management
    persistenceEntity.slaPolicyId = domainEntity.slaPolicyId;
    persistenceEntity.firstResponseDueAt = domainEntity.firstResponseDueAt;
    persistenceEntity.resolutionDueAt = domainEntity.resolutionDueAt;
    persistenceEntity.isSlaBreached = domainEntity.isSlaBreached;

    // Metrics & Resolution
    persistenceEntity.resolutionCode = domainEntity.resolutionCode;
    persistenceEntity.resolutionNotes = domainEntity.resolutionNotes;
    persistenceEntity.csatScore = domainEntity.csatScore;
    persistenceEntity.timeSpentSeconds = domainEntity.timeSpentSeconds;

    // Timestamps
    persistenceEntity.firstRespondedAt = domainEntity.firstRespondedAt;
    persistenceEntity.resolvedAt = domainEntity.resolvedAt;
    persistenceEntity.closedAt = domainEntity.closedAt;

    return persistenceEntity;
  }
}
