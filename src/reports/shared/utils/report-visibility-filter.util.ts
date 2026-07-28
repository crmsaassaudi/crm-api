import { ClsService } from 'nestjs-cls';
import { Types } from 'mongoose';
import { VisibilityModule } from '../../../common/permissions/visibility-modules';

type VisibilityAxes = {
  ownerIds: string[] | null;
  orgUnitIds: string[] | null;
};

const objectIds = (ids: unknown): Types.ObjectId[] =>
  Array.isArray(ids)
    ? ids
        .map(String)
        .filter((id) => Types.ObjectId.isValid(id))
        .map((id) => new Types.ObjectId(id))
    : [];

const resolveAxes = (
  cls: ClsService,
  module: VisibilityModule,
): VisibilityAxes => {
  const byModule = cls.get('dataVisibilityByModule') as
    | Record<string, VisibilityAxes>
    | undefined;
  return (
    byModule?.[module] ?? {
      ownerIds: cls.get('visibleOwnerIds'),
      orgUnitIds: cls.get('visibleOrgUnitIds'),
    }
  );
};

const withAbacFilter = (
  cls: ClsService,
  base: Record<string, unknown>,
  resources: string[],
): Record<string, unknown> => {
  const compiled = cls.get<{
    resource?: string;
    filter?: Record<string, unknown> | null;
  }>('abacResourceFilter');
  if (
    !compiled?.filter ||
    !compiled.resource ||
    !resources.includes(compiled.resource.toLowerCase())
  ) {
    return base;
  }
  const clauses = [
    ...((base.$and as Record<string, unknown>[] | undefined) ?? []),
    compiled.filter,
  ];
  const remainder = { ...base };
  delete remainder.$and;
  if (Object.keys(remainder).length > 0) clauses.unshift(remainder);
  return { $and: clauses };
};

/**
 * Compile the request's already-resolved data-visibility axes into a Mongo
 * aggregation predicate. Aggregations do not pass through BaseDocumentRepository,
 * so they must apply the same predicate explicitly.
 *
 * `undefined` means a non-HTTP/system path where visibility was not evaluated;
 * `null` is the explicit unrestricted result. Both intentionally add no row
 * predicate, matching repository behaviour.
 */
export const buildCrmReportVisibilityFilter = (
  cls: ClsService,
  module: Exclude<VisibilityModule, 'Conversation'>,
): Record<string, unknown> => {
  const axes = resolveAxes(cls, module);
  const resources = [
    `${module.toLowerCase()}s`,
    `${module.toLowerCase()}_reports`,
  ];
  if (!Array.isArray(axes.ownerIds)) {
    return withAbacFilter(cls, {}, resources);
  }

  const clauses: Record<string, unknown>[] = [
    { ownerId: { $in: objectIds(axes.ownerIds) } },
  ];
  if (cls.get('includeUnownedInScope') === true) {
    clauses.push({ ownerId: null });
  }
  if (Array.isArray(axes.orgUnitIds) && axes.orgUnitIds.length > 0) {
    clauses.push({ orgUnitId: { $in: objectIds(axes.orgUnitIds) } });
  }
  return withAbacFilter(cls, { $and: [{ $or: clauses }] }, resources);
};

const conversationOwnerClauses = (
  cls: ClsService,
  ownerIds: string[],
  orgUnitIds: unknown,
): Record<string, unknown>[] => {
  const owners = objectIds(ownerIds);
  const clauses: Record<string, unknown>[] = [
    { assignedAgentId: { $in: owners } },
    { claimedById: { $in: owners } },
  ];
  const groups = objectIds(cls.get('visibleGroupIds'));
  if (groups.length > 0) {
    clauses.push({ assignedGroupId: { $in: groups } });
  }
  if (cls.get('includeUnownedInScope') === true) {
    clauses.push({ assignedAgentId: null, assignedGroupId: null });
  }
  const units = objectIds(orgUnitIds);
  if (units.length > 0) clauses.push({ orgUnitId: { $in: units } });
  return clauses;
};

export const buildConversationReportVisibilityFilter = (
  cls: ClsService,
): Record<string, unknown> => {
  const and: Record<string, unknown>[] = [];
  const servableChannels = cls.get('servableChannelIds');
  if (Array.isArray(servableChannels)) {
    and.push({ channelId: { $in: objectIds(servableChannels) } });
  }

  const axes = resolveAxes(cls, 'Conversation');
  const overrides =
    (cls.get('channelVisibilityOverrides') as Record<
      string,
      'private' | 'public_read'
    >) ?? {};
  const channelsOf = (kind: 'private' | 'public_read') =>
    objectIds(
      Object.entries(overrides)
        .filter(([, value]) => value === kind)
        .map(([id]) => id),
    );
  const privateChannels = channelsOf('private');
  const publicChannels = channelsOf('public_read');

  if (Array.isArray(axes.ownerIds)) {
    const clauses = conversationOwnerClauses(
      cls,
      axes.ownerIds,
      axes.orgUnitIds,
    );
    if (publicChannels.length > 0) {
      clauses.push({ channelId: { $in: publicChannels } });
    }
    and.push({ $or: clauses });
  } else if (privateChannels.length > 0) {
    const strictOwners = cls.get('strictOwnerIds');
    if (Array.isArray(strictOwners)) {
      and.push({
        $or: [
          { channelId: { $nin: privateChannels } },
          {
            $and: [
              { channelId: { $in: privateChannels } },
              {
                $or: conversationOwnerClauses(
                  cls,
                  strictOwners,
                  cls.get('strictOrgUnitIds'),
                ),
              },
            ],
          },
        ],
      });
    }
  }

  return withAbacFilter(
    cls,
    and.length > 0 ? { $and: and } : {},
    ['conversations', 'omni_reports'],
  );
};

/** Agent state/interaction documents store agentId as a string, not ObjectId. */
export const buildAgentReportVisibilityFilter = (
  cls: ClsService,
): Record<string, unknown> => {
  const axes = resolveAxes(cls, 'Conversation');
  const base = Array.isArray(axes.ownerIds)
    ? { agentId: { $in: axes.ownerIds.map(String) } }
    : {};
  return withAbacFilter(cls, base, ['agents', 'agent_reports']);
};
