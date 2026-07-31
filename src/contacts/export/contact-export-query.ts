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
  },
): Record<string, unknown> {
  return {
    filters: params.filters ?? [],
    search: params.search,
    lifecycleStage: params.lifecycleStage,
    __restrictToOwner: policy.restrictToOwner,
    __currentUserId: policy.currentUserId,
    __allowedCustomFieldKeys: policy.allowedCustomFieldKeys,
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
    restrictToOwner,
  };
}
