import { AutomationWorkflowRepository } from './automation-workflow.repository';

/**
 * The workflow list filter.
 *
 * Asserted on the query object rather than on results: what can go wrong here is
 * a filter that is silently ignored (the request succeeds and shows the wrong
 * rows) or a term that reaches Mongo unescaped.
 */
describe('AutomationWorkflowRepository.findAll filter', () => {
  const capture = async (
    filters?: Parameters<AutomationWorkflowRepository['findAll']>[1],
  ) => {
    let query: any;
    const repository = Object.create(
      AutomationWorkflowRepository.prototype,
    ) as any;
    repository.model = {
      find: (filter: any) => {
        query = filter;
        return {
          sort: () => ({ lean: () => ({ exec: () => Promise.resolve([]) }) }),
        };
      },
    };
    await repository.findAll('tenant-1', filters);
    return query;
  };

  it('should scope every query to the tenant', async () => {
    expect(await capture()).toEqual({ tenantId: 'tenant-1' });
  });

  it('should apply the status filter rather than ignore it', async () => {
    expect(await capture({ status: 'active' })).toMatchObject({
      tenantId: 'tenant-1',
      status: 'active',
    });
  });

  it('should search name and description', async () => {
    const query = await capture({ search: 'renewal' });

    expect(query.$or).toEqual([
      { name: { $regex: 'renewal', $options: 'i' } },
      { description: { $regex: 'renewal', $options: 'i' } },
    ]);
  });

  it('should escape regex metacharacters in the term', async () => {
    // An unescaped `.*(` is both a wrong result and a way to hand Mongo a
    // pathological pattern.
    const query = await capture({ search: 'a.*(b' });

    expect(query.$or[0].name.$regex).toBe('a\\.\\*\\(b');
  });

  it('should treat a blank term as no search at all', async () => {
    expect(await capture({ search: '   ' })).toEqual({ tenantId: 'tenant-1' });
  });
});
