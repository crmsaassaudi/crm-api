import { Ticket } from '../../../../domain/ticket';
import { TicketSchemaClass } from '../entities/ticket.schema';
import { UserMapper } from '../../../../../users/infrastructure/persistence/document/mappers/user.mapper';

export class TicketMapper {
  static toDomain(raw: TicketSchemaClass): Ticket {
    const domainEntity = new Ticket();
    domainEntity.id = raw._id.toString();
    domainEntity.tenantId = raw.tenantId?.toString();
    domainEntity.ticketNumber = raw.ticketNumber;
    domainEntity.subject = raw.subject;
    domainEntity.description = raw.description ?? '';

    // Customer Context
    domainEntity.contactId = raw.contactId?.toString();
    domainEntity.accountId = raw.accountId?.toString();
    domainEntity.dealId = raw.dealId === null ? null : raw.dealId?.toString();
    domainEntity.parentTicketId =
      raw.parentTicketId === null ? null : raw.parentTicketId?.toString();
    domainEntity.omniConversationId = raw.omniConversationId?.toString();
    domainEntity.linkedMessageIds = raw.linkedMessageIds;
    domainEntity.relatedTo = raw.relatedTo
      ? {
          type: raw.relatedTo.type,
          id: raw.relatedTo._id?.toString(),
          _id: raw.relatedTo._id?.toString(),
          name: raw.relatedTo.name,
        }
      : undefined;

    // Classification & Routing
    domainEntity.typeId = raw.typeId?.toString();
    domainEntity.categoryPath = raw.categoryPath;
    domainEntity.priority = raw.priority;
    domainEntity.channel = raw.channel;
    domainEntity.sourceId = raw.sourceId?.toString();
    domainEntity.tags = raw.tags;
    domainEntity.customFields = raw.customFields;

    // Assignment & Collaboration
    domainEntity.groupId = raw.groupId?.toString();
    domainEntity.ownerId = raw.ownerId?.toString();
    domainEntity.ownerAssignedExplicitly = raw.ownerAssignedExplicitly ?? false;
    domainEntity.orgUnitId = raw.orgUnitId?.toString() ?? null;
    domainEntity.statusId = raw.statusId?.toString();

    // SLA Management
    domainEntity.slaPolicyId = raw.slaPolicyId?.toString();
    domainEntity.firstResponseDueAt = raw.firstResponseDueAt;
    domainEntity.resolutionDueAt = raw.resolutionDueAt;
    domainEntity.isSlaBreached = raw.isSlaBreached ?? false;
    domainEntity.slaPausedAt = raw.slaPausedAt;
    domainEntity.slaResumedAt = raw.slaResumedAt;
    domainEntity.slaPausedSeconds = raw.slaPausedSeconds ?? 0;

    // Escalation
    domainEntity.escalationLevel = raw.escalationLevel ?? null;
    domainEntity.escalatedAt = raw.escalatedAt;
    domainEntity.escalatedToId = raw.escalatedToId?.toString() ?? null;

    // Metrics & Resolution
    domainEntity.resolutionCodeId = raw.resolutionCodeId?.toString();
    domainEntity.resolutionNotes = raw.resolutionNotes;
    domainEntity.csatScore = raw.csatScore;
    domainEntity.csatComment = raw.csatComment;
    domainEntity.csatSubmittedAt = raw.csatSubmittedAt;

    // Timestamps
    domainEntity.firstRespondedAt = raw.firstRespondedAt;
    domainEntity.firstRespondedById =
      raw.firstRespondedById?.toString() ?? null;
    domainEntity.resolvedAt = raw.resolvedAt;
    domainEntity.closedAt = raw.closedAt;
    domainEntity.reopenCount = raw.reopenCount ?? 0;
    domainEntity.reopenedAt = raw.reopenedAt;
    domainEntity.createdAt = raw.createdAt;
    domainEntity.updatedAt = raw.updatedAt;
    domainEntity.deletedAt = raw.deletedAt;
    domainEntity.createdById = raw.createdById?.toString();
    domainEntity.updatedById = raw.updatedById?.toString();
    domainEntity.version = (raw as any).__v;

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
    if ((raw as any).ticketStatus) {
      const s = (raw as any).ticketStatus;
      domainEntity.ticketStatus = {
        id: s._id?.toString(),
        label: s.label,
        apiName: s.apiName,
        color: s.color,
        isDefault: s.isDefault,
        isTerminal: s.isTerminal,
        terminalKind: s.terminalKind ?? null,
        pausesSla: s.pausesSla ?? false,
      };
    }
    if ((raw as any).ticketType) {
      const t = (raw as any).ticketType;
      domainEntity.ticketType = {
        id: t._id?.toString(),
        name: t.name,
        apiName: t.apiName,
        color: t.color,
      };
    }
    if ((raw as any).ticketSource) {
      const src = (raw as any).ticketSource;
      domainEntity.ticketSource = {
        id: src._id?.toString(),
        name: src.name,
      };
    }
    if ((raw as any).ticketResolution) {
      const r = (raw as any).ticketResolution;
      domainEntity.ticketResolution = {
        id: r._id?.toString(),
        name: r.name,
        apiName: r.apiName,
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
    // `!== undefined` rather than truthy: unlinkDeal writes an explicit null, and a
    // truthy check would make "unlink" a silent no-op — the mirror of the bug that made
    // "link" one. The mapper is the whitelist `update()` writes through.
    if (domainEntity.dealId !== undefined) {
      persistenceEntity.dealId = domainEntity.dealId;
    }
    if (domainEntity.parentTicketId !== undefined) {
      persistenceEntity.parentTicketId = domainEntity.parentTicketId;
    }
    persistenceEntity.omniConversationId = domainEntity.omniConversationId;
    persistenceEntity.linkedMessageIds = domainEntity.linkedMessageIds;
    persistenceEntity.relatedTo = domainEntity.relatedTo;

    // Classification & Routing
    persistenceEntity.typeId = domainEntity.typeId;
    persistenceEntity.categoryPath = domainEntity.categoryPath;
    persistenceEntity.priority = domainEntity.priority;
    persistenceEntity.channel = domainEntity.channel;
    persistenceEntity.sourceId = domainEntity.sourceId;
    persistenceEntity.tags = domainEntity.tags;
    persistenceEntity.customFields = domainEntity.customFields;

    // Assignment & Collaboration
    persistenceEntity.groupId = domainEntity.groupId;
    persistenceEntity.ownerId = domainEntity.ownerId;
    if (domainEntity.ownerAssignedExplicitly !== undefined) {
      persistenceEntity.ownerAssignedExplicitly =
        domainEntity.ownerAssignedExplicitly;
    }
    persistenceEntity.orgUnitId = domainEntity.orgUnitId;
    persistenceEntity.statusId = domainEntity.statusId;

    // SLA Management
    persistenceEntity.slaPolicyId = domainEntity.slaPolicyId;
    persistenceEntity.firstResponseDueAt = domainEntity.firstResponseDueAt;
    persistenceEntity.resolutionDueAt = domainEntity.resolutionDueAt;
    persistenceEntity.isSlaBreached = domainEntity.isSlaBreached;
    persistenceEntity.slaPausedAt = domainEntity.slaPausedAt;
    persistenceEntity.slaResumedAt = domainEntity.slaResumedAt;
    persistenceEntity.slaPausedSeconds = domainEntity.slaPausedSeconds;

    // Metrics & Resolution
    persistenceEntity.resolutionCodeId = domainEntity.resolutionCodeId;
    persistenceEntity.resolutionNotes = domainEntity.resolutionNotes;
    persistenceEntity.csatScore = domainEntity.csatScore;

    // Timestamps
    //
    // `!== undefined` on the terminal stamps and the reopen counter: reopening
    // writes explicit nulls to clear `resolvedAt`/`closedAt`, and a truthy
    // check would drop them — leaving a live ticket still stamped resolved,
    // which is what every resolution-time metric reads.
    persistenceEntity.firstRespondedAt = domainEntity.firstRespondedAt;
    if (domainEntity.firstRespondedById !== undefined) {
      persistenceEntity.firstRespondedById = domainEntity.firstRespondedById;
    }
    if (domainEntity.resolvedAt !== undefined) {
      persistenceEntity.resolvedAt = domainEntity.resolvedAt;
    }
    if (domainEntity.closedAt !== undefined) {
      persistenceEntity.closedAt = domainEntity.closedAt;
    }
    if (domainEntity.reopenCount !== undefined) {
      persistenceEntity.reopenCount = domainEntity.reopenCount;
    }
    if (domainEntity.reopenedAt !== undefined) {
      persistenceEntity.reopenedAt = domainEntity.reopenedAt;
    }

    // Escalation
    if (domainEntity.escalationLevel !== undefined) {
      persistenceEntity.escalationLevel = domainEntity.escalationLevel;
    }
    if (domainEntity.escalatedAt !== undefined) {
      persistenceEntity.escalatedAt = domainEntity.escalatedAt;
    }
    if (domainEntity.escalatedToId !== undefined) {
      persistenceEntity.escalatedToId = domainEntity.escalatedToId;
    }

    return persistenceEntity;
  }
}
