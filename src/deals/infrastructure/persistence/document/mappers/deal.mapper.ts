import { Deal } from '../../../../domain/deal';
import { DealSchemaClass } from '../entities/deal.schema';
import { UserMapper } from '../../../../../users/infrastructure/persistence/document/mappers/user.mapper';

const id = (value: unknown): string | undefined => {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'object' && '_id' in (value as any)) {
    return String((value as any)._id);
  }
  return String(value);
};

/**
 * Fields the caller may write, in schema order.
 *
 * `toPersistence` used to hand-assign every property, and the two it happened to
 * miss — `unassignedReason` and `orgUnitId` — became silently unwritable:
 * `BaseDocumentRepository.updateIfExists` builds its `$set` from this object's
 * keys, so a field absent here is dropped from every PATCH. A re-assigned deal
 * kept its "owner left the tenant" flag forever because of it. Driving the copy
 * from one list is what makes that class of omission visible.
 *
 * `stageHistory` is deliberately absent: it is append-only and written with
 * `$push` by the repository, never replaced by a caller's payload.
 */
const WRITABLE_KEYS = [
  'tenantId',
  'title',
  'name',
  'pipelineId',
  'stageId',
  'stageEnteredAt',
  'probability',
  'value',
  'currency',
  'accountId',
  'accountName',
  'contactIds',
  'ownerId',
  'ownerAssignedExplicitly',
  'unassignedReason',
  'orgUnitId',
  'description',
  'sourceId',
  'utmSource',
  'utmMedium',
  'utmCampaign',
  'lostReason',
  'tags',
  'customFields',
  'closeDate',
  'nextFollowUpAt',
  'followUpNotifiedAt',
  'lastActivityAt',
  'wonAt',
  'lostAt',
  'createdById',
  'updatedById',
  'omniConversationId',
  'linkedMessageIds',
] as const;

export class DealMapper {
  static toDomain(raw: DealSchemaClass): Deal {
    const source = raw as unknown as Record<string, any>;
    const domainEntity = new Deal();

    domainEntity.id = raw._id.toString();
    domainEntity.tenantId = id(raw.tenantId) as string;
    domainEntity.title = raw.title;
    domainEntity.name = raw.name;
    domainEntity.pipelineId = id(raw.pipelineId) as string;
    domainEntity.stageId = id(raw.stageId) as string;
    domainEntity.stageEnteredAt = raw.stageEnteredAt;
    domainEntity.probability = raw.probability;
    domainEntity.value = raw.value;
    domainEntity.currency = raw.currency;
    domainEntity.accountId = id(raw.accountId);
    domainEntity.accountName = raw.accountName;
    domainEntity.contactIds = raw.contactIds?.map((c) => String(c));
    domainEntity.ownerId = id(raw.ownerId);
    domainEntity.ownerAssignedExplicitly = raw.ownerAssignedExplicitly;
    domainEntity.unassignedReason = raw.unassignedReason ?? null;
    domainEntity.createdById = id(raw.createdById);
    domainEntity.updatedById = id(raw.updatedById);
    domainEntity.description = raw.description;
    domainEntity.sourceId = id(raw.sourceId);
    domainEntity.utmSource = raw.utmSource ?? null;
    domainEntity.utmMedium = raw.utmMedium ?? null;
    domainEntity.utmCampaign = raw.utmCampaign ?? null;
    domainEntity.lostReason = raw.lostReason;
    domainEntity.tags = raw.tags;
    domainEntity.customFields = raw.customFields;
    domainEntity.omniConversationId = id(raw.omniConversationId);
    domainEntity.linkedMessageIds = raw.linkedMessageIds?.map((m) => String(m));
    domainEntity.closeDate = raw.closeDate;
    domainEntity.nextFollowUpAt = raw.nextFollowUpAt ?? null;
    domainEntity.lastActivityAt = raw.lastActivityAt;
    domainEntity.wonAt = raw.wonAt;
    domainEntity.lostAt = raw.lostAt;
    domainEntity.createdAt = raw.createdAt;
    domainEntity.updatedAt = raw.updatedAt;
    domainEntity.deletedAt = raw.deletedAt;
    domainEntity.version = source.__v;

    domainEntity.stageHistory = (raw.stageHistory ?? []).map((entry) => ({
      fromStageId: entry.fromStageId ? String(entry.fromStageId) : null,
      toStageId: String(entry.toStageId),
      changedAt: entry.changedAt,
      changedById: entry.changedById ? String(entry.changedById) : null,
      durationMs: entry.durationMs ?? null,
    }));

    if (source.owner) {
      domainEntity.owner = UserMapper.toDomain(source.owner);
    }
    if (source.dealStage) {
      const stage = source.dealStage;
      domainEntity.dealStage = {
        id: String(stage._id),
        label: stage.label,
        apiName: stage.apiName,
        color: stage.color,
        probability: stage.probability,
        isWon: stage.isWon,
        isLost: stage.isLost,
      };
    }
    if (source.dealSource) {
      domainEntity.dealSource = {
        id: String(source.dealSource._id),
        name: source.dealSource.name,
      };
    }
    if (source.pipeline) {
      domainEntity.pipelineName = source.pipeline.name;
    }

    return domainEntity;
  }

  static toPersistence(domainEntity: Deal): DealSchemaClass {
    const source = domainEntity as unknown as Record<string, unknown>;
    const persistenceEntity = {} as DealSchemaClass;
    const target = persistenceEntity as unknown as Record<string, unknown>;

    if (domainEntity.id) {
      persistenceEntity._id = domainEntity.id;
    }
    for (const key of WRITABLE_KEYS) {
      target[key] = source[key];
    }
    if (domainEntity.version !== undefined) {
      target.__v = domainEntity.version;
    }

    return persistenceEntity;
  }
}
