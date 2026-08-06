import { ExportContactsDto } from '../dto/export-contacts.dto';

/**
 * Converts the public list-query contract into the repository's filter shape.
 * Export must use the exact same search and filters as the visible list; losing
 * either here silently broadens the data set and is a data-governance defect.
 */
export function buildContactExportQuery(
  params: ExportContactsDto,
  policy: {
    restrictToOwner: boolean;
    currentUserId?: string;
    allowedCustomFieldKeys?: ReadonlySet<string>;
    /**
     * Segment membership, compiled at enqueue time. Resolved here rather than in
     * the worker because a dynamic segment's definition can change between
     * queuing an export and running it — the file must contain the audience the
     * user pressed the button on.
     */
    segmentFilter?: Record<string, unknown>;
  },
): Record<string, unknown> {
  return {
    filters: params.filters ?? [],
    search: params.search,
    lifecycleStage: params.lifecycleStage,
    __restrictToOwner: policy.restrictToOwner,
    __currentUserId: policy.currentUserId,
    __allowedCustomFieldKeys: policy.allowedCustomFieldKeys,
    __segmentFilter: policy.segmentFilter,
  };
}

export function buildContactExportSnapshot(
  params: ExportContactsDto,
  restrictToOwner: boolean,
) {
  return {
    ids: params.ids,
    filters: params.filters ?? [],
    search: params.search,
    lifecycleStage: params.lifecycleStage,
    segmentId: params.segmentId,
    restrictToOwner,
  };
}
