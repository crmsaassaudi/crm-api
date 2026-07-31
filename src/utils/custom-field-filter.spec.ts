import { applyRegisteredCustomFieldFilters } from './custom-field-filter';

describe('applyRegisteredCustomFieldFilters', () => {
  it('should accepts only registered keys and coerces typed values', () => {
    const where: Record<string, any> = {};
    applyRegisteredCustomFieldFilters(
      where,
      [
        { id: 'customFields.budget', value: '42' },
        { id: 'customFields.enabled', value: 'false' },
        { id: 'customFields.unknown', value: 'secret' },
      ],
      { budget: 'CURRENCY', enabled: 'BOOLEAN' },
    );
    expect(where).toEqual({
      'customFields.budget': 42,
      'customFields.enabled': false,
    });
  });

  it('should rejects nested/operator paths even when their prefix is registered', () => {
    const where: Record<string, any> = {};
    applyRegisteredCustomFieldFilters(
      where,
      [{ id: 'customFields.safe.$ne', value: null }],
      { safe: 'TEXT' },
    );
    expect(where).toEqual({});
  });

  it('should turns DATE equality into a bounded UTC day query', () => {
    const where: Record<string, any> = {};
    applyRegisteredCustomFieldFilters(
      where,
      [{ id: 'customFields.renewalDate', value: '2026-07-30' }],
      { renewalDate: 'DATE' },
    );
    expect(where['customFields.renewalDate']).toEqual({
      $gte: new Date('2026-07-30T00:00:00.000Z'),
      $lt: new Date('2026-07-31T00:00:00.000Z'),
    });
  });
});
