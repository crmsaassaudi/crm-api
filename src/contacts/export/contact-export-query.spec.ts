import {
  buildContactExportQuery,
  buildContactExportSnapshot,
} from './contact-export-query';

describe('contact export query snapshot', () => {
  const params = {
    filters: [{ id: 'customFields.tier', value: 'enterprise' }],
    search: 'Acme',
    lifecycleStage: 'customer',
  };

  it('should preserve the complete visible-list query for the export worker', () => {
    const allowed = new Set(['tier']);
    expect(
      buildContactExportQuery(params, {
        restrictToOwner: true,
        currentUserId: 'user-1',
        allowedCustomFieldKeys: allowed,
      }),
    ).toEqual({
      filters: params.filters,
      search: 'Acme',
      lifecycleStage: 'customer',
      __restrictToOwner: true,
      __currentUserId: 'user-1',
      __allowedCustomFieldKeys: allowed,
    });
  });

  it('should store an immutable-value audit snapshot instead of only record ids', () => {
    expect(buildContactExportSnapshot(params, false)).toEqual({
      ids: undefined,
      filters: params.filters,
      search: 'Acme',
      lifecycleStage: 'customer',
      restrictToOwner: false,
    });
  });
});
