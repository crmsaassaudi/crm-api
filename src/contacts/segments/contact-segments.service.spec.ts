import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ContactSegmentsService } from './contact-segments.service';

/**
 * A segment compiles to a Mongo predicate that decides who receives a campaign,
 * so the failure that matters most is not "no results" — it is "everyone".
 */
const build = (segment?: Record<string, any>) => {
  const model = {
    find: jest.fn(() => ({
      sort: () => ({
        limit: () => ({ lean: () => ({ exec: () => Promise.resolve([]) }) }),
      }),
    })),
    findOne: jest.fn(() => ({ exec: () => Promise.resolve(segment ?? null) })),
    findOneAndDelete: jest.fn(() => ({
      exec: () => Promise.resolve(segment ?? null),
    })),
    create: jest.fn((doc: any) =>
      Promise.resolve({ toObject: () => ({ _id: 'seg_1', ...doc }) }),
    ),
  };

  const service = new ContactSegmentsService(
    model as any,
    { getByModule: jest.fn().mockResolvedValue([]) } as any,
    { get: jest.fn(() => 'tenant_1') } as any,
  );

  return { service, model };
};

describe('ContactSegmentsService — membership', () => {
  it('should compile a dynamic segment into its predicate', async () => {
    const { service } = build({
      type: 'dynamic',
      filter: {
        match: 'all',
        conditions: [{ field: 'country', operator: 'eq', value: 'SA' }],
      },
    });

    expect(await service.buildMembershipFilter('seg_1')).toEqual({
      $and: [{ country: 'SA' }],
    });
  });

  it('should match NOBODY when a dynamic segment compiles to nothing', async () => {
    // The one answer that must never be "no predicate": an empty filter selects
    // every contact in the tenant, which is how a campaign goes to the whole
    // database instead of to an audience.
    const { service } = build({
      type: 'dynamic',
      filter: { match: 'all', conditions: [] },
    });

    expect(await service.buildMembershipFilter('seg_1')).toEqual({
      _id: { $in: [] },
    });
  });

  it('should read a static segment from its explicit member list', async () => {
    const { service } = build({
      type: 'static',
      memberIds: ['507f1f77bcf86cd799439011'],
    });

    const filter = await service.buildMembershipFilter('seg_1');
    expect(String((filter._id as any).$in[0])).toBe('507f1f77bcf86cd799439011');
  });

  it('should match nobody for an empty static segment', async () => {
    const { service } = build({ type: 'static', memberIds: [] });
    expect(await service.buildMembershipFilter('seg_1')).toEqual({
      _id: { $in: [] },
    });
  });

  it('should refuse a segment id that does not exist', async () => {
    const { service } = build(undefined);
    await expect(service.buildMembershipFilter('missing')).rejects.toThrow(
      NotFoundException,
    );
  });
});

describe('ContactSegmentsService — validation at save time', () => {
  it('should refuse a dynamic segment with no conditions', async () => {
    const { service } = build();
    await expect(
      service.create({ name: 'Everyone', type: 'dynamic' } as any),
    ).rejects.toThrow(BadRequestException);
  });

  it('should refuse a condition the compiler cannot honour', async () => {
    // Rejected when it is saved rather than when it is sent: an audience that
    // fails at send time fails in front of a customer.
    const { service } = build();
    await expect(
      service.create({
        name: 'Bad',
        type: 'dynamic',
        filter: {
          match: 'all',
          conditions: [{ field: 'tenantId', operator: 'eq', value: 'x' }],
        },
      } as any),
    ).rejects.toThrow(BadRequestException);
  });

  it('should not store a filter on a static segment', async () => {
    const { service, model } = build();

    await service.create({
      name: 'Launch list',
      type: 'static',
      memberIds: ['507f1f77bcf86cd799439011'],
      filter: {
        match: 'all',
        conditions: [{ field: 'isVIP', operator: 'eq', value: true }],
      },
    } as any);

    expect(model.create).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'static', filter: undefined }),
    );
  });
});
