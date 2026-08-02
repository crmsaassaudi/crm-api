import { UsersDocumentRepository } from './user.repository';

/**
 * `searchByTenant` replaced "load every member of the tenant, then slice a page
 * in Node". Three things about the replacement are load-bearing and none of
 * them are visible from the call site, so they are pinned here.
 */
describe('UsersDocumentRepository.searchByTenant', () => {
  const tenantId = 'tenant_1';

  let chain: any;
  let model: any;
  let repository: UsersDocumentRepository;

  beforeEach(() => {
    chain = {
      sort: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([]),
    };
    model = {
      find: jest.fn().mockReturnValue(chain),
      countDocuments: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue(0),
      }),
    };
    repository = new UsersDocumentRepository(model, { get: jest.fn() } as any);
  });

  it('should page in the database rather than materialising the tenant', async () => {
    await repository.searchByTenant(tenantId, { page: 3, limit: 50 });

    expect(model.find).toHaveBeenCalledWith({ 'tenants.tenantId': tenantId });
    expect(chain.skip).toHaveBeenCalledWith(100);
    expect(chain.limit).toHaveBeenCalledWith(50);
  });

  it('should sort by a total order so infinite scroll cannot duplicate or skip rows', async () => {
    await repository.searchByTenant(tenantId, { page: 1, limit: 10 });

    // Without `_id`, two people named "An" occupy an unstable relative
    // position and shuffle between page boundaries on every request.
    expect(chain.sort).toHaveBeenCalledWith({
      firstName: 1,
      lastName: 1,
      _id: 1,
    });
  });

  it('should search name and email case-insensitively', async () => {
    await repository.searchByTenant(tenantId, {
      search: 'nguyen',
      page: 1,
      limit: 10,
    });

    expect(model.find).toHaveBeenCalledWith({
      'tenants.tenantId': tenantId,
      $or: [
        { firstName: { $regex: 'nguyen', $options: 'i' } },
        { lastName: { $regex: 'nguyen', $options: 'i' } },
        { email: { $regex: 'nguyen', $options: 'i' } },
      ],
    });
  });

  it('should escape regex metacharacters in the search term', async () => {
    // `a+(b` is a valid thing to type into a search box and an invalid regex.
    // Unescaped it throws inside the driver; some shapes stall the query.
    await repository.searchByTenant(tenantId, {
      search: 'a+(b',
      page: 1,
      limit: 10,
    });

    const filter = model.find.mock.calls[0][0];
    expect(filter.$or[0].firstName.$regex).toBe('a\\+\\(b');
  });

  it('should ignore a whitespace-only term instead of filtering on it', async () => {
    await repository.searchByTenant(tenantId, {
      search: '   ',
      page: 1,
      limit: 10,
    });

    expect(model.find).toHaveBeenCalledWith({ 'tenants.tenantId': tenantId });
  });

  it('should count against the same filter it pages, not the whole tenant', async () => {
    await repository.searchByTenant(tenantId, {
      search: 'lan',
      page: 2,
      limit: 25,
    });

    expect(model.countDocuments).toHaveBeenCalledWith(
      model.find.mock.calls[0][0],
    );
  });
});
