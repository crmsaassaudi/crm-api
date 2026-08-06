import { ContactValueRollupService } from './contact-value-rollup.service';

/**
 * Customer value is what a B2C list sorts and segments by, so the two ways it
 * can be wrong both matter: counting an OPEN deal as revenue inflates every
 * customer, and missing a contact removed from a deal leaves revenue attributed
 * to someone who did not buy.
 */
const build = (
  dealRow?: Record<string, any>,
  deal: Record<string, any> | null = {
    contactIds: ['507f1f77bcf86cd799439011'],
  },
) => {
  const updateOne = jest.fn().mockResolvedValue({});
  const aggregate = jest.fn(() => ({
    toArray: () => Promise.resolve(dealRow ? [dealRow] : []),
  }));
  const findOne = jest.fn().mockResolvedValue(deal);

  const connection = {
    collection: jest.fn((name: string) =>
      name === 'contacts' ? { updateOne } : { aggregate, findOne },
    ),
  };

  return {
    service: new ContactValueRollupService(connection as any),
    updateOne,
    aggregate,
    findOne,
  };
};

const CONTACT = '507f1f77bcf86cd799439011';
const TENANT = '507f1f77bcf86cd799439099';

describe('ContactValueRollupService', () => {
  it('should write the aggregated value onto the contact', async () => {
    const purchase = new Date('2026-05-01');
    const { service, updateOne } = build({
      totalRevenue: 4200,
      dealsCount: 7,
      wonDealsCount: 3,
      firstPurchaseAt: new Date('2025-01-01'),
      lastPurchaseAt: purchase,
    });

    const value = await service.recompute(TENANT, CONTACT);

    expect(value.totalRevenue).toBe(4200);
    expect(value.lastPurchaseAt).toBe(purchase);
    expect(updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: expect.anything() }),
      { $set: expect.objectContaining({ totalRevenue: 4200 }) },
    );
  });

  it('should write zeros for a contact with no deals', async () => {
    // Not "leave it alone": a contact whose only won deal was reopened must stop
    // reading as a customer, or a value segment keeps them forever.
    const { service, updateOne } = build(undefined);

    const value = await service.recompute(TENANT, CONTACT);

    expect(value).toEqual({
      totalRevenue: 0,
      dealsCount: 0,
      wonDealsCount: 0,
      firstPurchaseAt: null,
      lastPurchaseAt: null,
    });
    expect(updateOne).toHaveBeenCalled();
  });

  it('should count revenue only from won deals', async () => {
    const { service, aggregate } = build({ totalRevenue: 0, dealsCount: 2 });

    await service.recompute(TENANT, CONTACT);

    const [pipeline] = aggregate.mock.calls[0] as any[];
    const group = pipeline.find((stage: any) => stage.$group).$group;
    // Revenue and both purchase dates are conditional on `wonAt`; only
    // `dealsCount` counts everything. An open deal is a hope, not money.
    expect(JSON.stringify(group.totalRevenue)).toContain('wonAt');
    expect(group.dealsCount).toEqual({ $sum: 1 });
    expect(group.firstPurchaseAt).toEqual({ $min: '$wonAt' });
  });

  it('should exclude deleted deals', async () => {
    const { service, aggregate } = build({ totalRevenue: 0 });

    await service.recompute(TENANT, CONTACT);

    const [pipeline] = aggregate.mock.calls[0] as any[];
    expect(pipeline[0].$match).toEqual(
      expect.objectContaining({ deletedAt: null }),
    );
  });

  it('should recompute a contact REMOVED from the deal', async () => {
    // Reachable only through the old snapshot — the deal no longer points at
    // them, so their total would keep the revenue of a deal they are not on.
    const removed = '507f1f77bcf86cd799439022';
    const { service, updateOne } = build(
      { totalRevenue: 0 },
      { contactIds: [CONTACT] },
    );

    await service.onDealChanged({
      tenantId: TENANT,
      entityId: '507f1f77bcf86cd799439033',
      oldSnapshot: { contactIds: [CONTACT, removed] },
      newSnapshot: { contactIds: [CONTACT] },
    });

    const touched = updateOne.mock.calls.map((call) => String(call[0]._id));
    expect(touched).toContain(removed);
    expect(touched).toContain(CONTACT);
  });

  it('should not let a rollup failure break the deal write that triggered it', async () => {
    const { service, findOne } = build({ totalRevenue: 0 });
    findOne.mockRejectedValue(new Error('mongo down'));

    await expect(
      service.onDealChanged({ tenantId: TENANT, entityId: CONTACT }),
    ).resolves.toBeUndefined();
  });

  it('should ignore an event with no tenant', async () => {
    const { service, updateOne } = build({ totalRevenue: 0 });
    await service.onDealChanged({ entityId: CONTACT });
    expect(updateOne).not.toHaveBeenCalled();
  });
});
