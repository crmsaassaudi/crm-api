import { computeSearchKeys } from './search-keys.plugin';

describe('computeSearchKeys', () => {
  it('indexes primitive values nested inside a Mixed customFields object', () => {
    const result = computeSearchKeys(
      {
        title: 'Renewal',
        customFields: {
          licensePlate: 'ABC-1234',
          referralCode: 'FRIEND50',
          isVip: true, // booleans are not searchable text
          nested: { region: 'Riyadh' },
        },
      },
      { fields: ['title', 'customFields'] },
    );

    expect(result.searchKeys).toEqual(
      expect.arrayContaining([
        expect.stringContaining('abc'),
        expect.stringContaining('friend50'),
        expect.stringContaining('riyadh'),
      ]),
    );
  });

  it('does not index custom fields as PII even when they hold contact-shaped values', () => {
    const result = computeSearchKeys(
      { customFields: { backupPhone: '0501234567' } },
      { fields: ['customFields'] },
    );

    expect(result.searchKeysPii).toEqual([]);
    expect(result.searchKeys.length).toBeGreaterThan(0);
  });

  it('produces no keys when customFields is absent', () => {
    const result = computeSearchKeys(
      { title: 'No custom fields here' },
      { fields: ['title', 'customFields'] },
    );

    expect(result.searchKeys.length).toBeGreaterThan(0);
  });
});
