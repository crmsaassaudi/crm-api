import {
  applyReportQueryOptions,
  reportAggregate,
} from './report-aggregate.util';

function makeAggregate() {
  const calls: Record<string, any[]> = {
    allowDiskUse: [],
    option: [],
    read: [],
  };
  const aggregate: any = {
    allowDiskUse: (v: boolean) => {
      calls.allowDiskUse.push(v);
      return aggregate;
    },
    option: (o: any) => {
      calls.option.push(o);
      return aggregate;
    },
    read: (p: any) => {
      calls.read.push(p);
      return aggregate;
    },
  };
  return { aggregate, calls };
}

function makeModel() {
  const { aggregate, calls } = makeAggregate();
  const model: any = { aggregate: jest.fn(() => aggregate) };
  return { model, calls };
}

describe('reportAggregate', () => {
  const original = process.env.REPORT_READ_PREFERENCE;
  afterEach(() => {
    if (original === undefined) delete process.env.REPORT_READ_PREFERENCE;
    else process.env.REPORT_READ_PREFERENCE = original;
  });

  it('should enable allowDiskUse by default', () => {
    // A $group whose working set passes 100MB fails outright without this — and
    // it fails first for the largest tenant, i.e. the one most likely to look.
    const { model, calls } = makeModel();
    reportAggregate(model, [{ $match: {} }]);
    expect(calls.allowDiskUse).toEqual([true]);
  });

  it('should read from a secondary by default, keeping report scans off the primary', () => {
    const { model, calls } = makeModel();
    reportAggregate(model, []);
    // `secondaryPreferred`, not `secondary`: the latter fails on a single-node
    // deployment, which is how this would break a dev or small install.
    expect(calls.read).toEqual(['secondaryPreferred']);
  });

  it('should bound the pipeline with maxTimeMS', () => {
    const { model, calls } = makeModel();
    reportAggregate(model, []);
    expect(calls.option[0].maxTimeMS).toBeGreaterThan(0);
  });

  it('should let a caller force the primary when staleness is unacceptable', () => {
    const { model, calls } = makeModel();
    reportAggregate(model, [], { readPreference: 'primary' });
    expect(calls.read).toEqual(['primary']);
  });

  it('should honour REPORT_READ_PREFERENCE as an ops escape hatch', () => {
    // A replica set with unhealthy secondaries has to be recoverable without a
    // code change.
    process.env.REPORT_READ_PREFERENCE = 'primary';
    const { model, calls } = makeModel();
    reportAggregate(model, []);
    expect(calls.read).toEqual(['primary']);
  });

  it('should let an explicit option beat the env default', () => {
    process.env.REPORT_READ_PREFERENCE = 'primary';
    const { model, calls } = makeModel();
    reportAggregate(model, [], { readPreference: 'secondaryPreferred' });
    expect(calls.read).toEqual(['secondaryPreferred']);
  });

  it('should pass the pipeline through untouched', () => {
    const { model } = makeModel();
    const pipeline = [{ $match: { tenantId: 't1' } }, { $count: 'n' }];
    reportAggregate(model, pipeline);
    expect(model.aggregate).toHaveBeenCalledWith(pipeline);
  });
});

describe('applyReportQueryOptions', () => {
  it('should bound and redirect a plain count query too', () => {
    // A report's countDocuments scans as much as its pipeline does.
    const seen: Record<string, any> = {};
    const query: any = {
      maxTimeMS: (ms: number) => {
        seen.maxTimeMS = ms;
        return query;
      },
      read: (p: any) => {
        seen.read = p;
        return query;
      },
    };

    applyReportQueryOptions(query);

    expect(seen.maxTimeMS).toBeGreaterThan(0);
    expect(seen.read).toBe('secondaryPreferred');
  });
});
