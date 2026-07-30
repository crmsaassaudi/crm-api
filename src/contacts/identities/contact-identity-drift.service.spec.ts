import { ContactIdentityDriftService } from './contact-identity-drift.service';

const C1 = '60d0fe4f5311236168a109ca';
const C2 = '60d0fe4f5311236168a109cb';

/**
 * A stand-in for a Mongoose query chain.
 *
 * `setOptions` is recorded rather than merely accepted: this service reads across
 * tenants from a cron, so it MUST declare `isPlatformQuery` — without it the tenant
 * plugin throws and the drift check reports nothing, which is the silence it exists to
 * break. A mock has no plugin, so nothing but an explicit assertion can catch that, and
 * the omission survived here for exactly that reason.
 */
function chain(rows: any[]) {
  const options: Record<string, unknown>[] = [];
  const q: any = {
    options,
    setOptions: (opts: Record<string, unknown>) => {
      options.push(opts);
      return q;
    },
    select: () => q,
    sort: () => q,
    limit: () => q,
    lean: () => q,
    read: () => q,
    exec: () => Promise.resolve(rows),
  };
  return q;
}

function makeService(contacts: any[], identityRows: any[]) {
  const chains: any[] = [];
  const track = (rows: any[]) => {
    const q = chain(rows);
    chains.push(q);
    return q;
  };
  const contactModel: any = { find: jest.fn(() => track(contacts)) };
  const identityModel: any = { find: jest.fn(() => track(identityRows)) };
  const lockService: any = {
    acquire: jest.fn((_k: string, _o: unknown, fn: any) => fn()),
  };
  return {
    service: new ContactIdentityDriftService(
      contactModel,
      identityModel,
      lockService,
    ),
    contactModel,
    identityModel,
    lockService,
    chains,
  };
}

/**
 * The projection is non-throwing by design, so drift is a normal operating condition.
 * These tests pin that the watcher actually notices it — a health check that reports
 * clean while the thing it watches is broken is worse than no check.
 */
describe('ContactIdentityDriftService — detection', () => {
  it('should report clean when the projection matches', async () => {
    const { service } = makeService(
      [{ _id: C1, emails: ['a@x.com'], phones: [], omniIdentities: [] }],
      [{ contactId: C1, type: 'email', normalisedValue: 'a@x.com' }],
    );

    expect(await service.sample()).toEqual({
      scanned: 1,
      missing: 0,
      orphaned: 0,
      samples: [],
    });
  });

  it('should detect a MISSING row — the unique index is not protecting that value', async () => {
    const { service } = makeService(
      [{ _id: C1, emails: ['a@x.com'], phones: [], omniIdentities: [] }],
      [],
    );

    const report = await service.sample();
    expect(report.missing).toBe(1);
    expect(report.samples[0]).toContain('missing');
    expect(report.samples[0]).toContain('email:a@x.com');
  });

  it('should detect an ORPHANED row — still reserving a value the contact dropped', async () => {
    const { service } = makeService(
      [{ _id: C1, emails: [], phones: [], omniIdentities: [] }],
      [{ contactId: C1, type: 'email', normalisedValue: 'gone@x.com' }],
    );

    const report = await service.sample();
    expect(report.orphaned).toBe(1);
    expect(report.samples[0]).toContain('orphaned');
  });

  it('should normalise before comparing, so casing is not reported as drift', async () => {
    // A checker with its own idea of normalisation reports differences that are its
    // own — and a checker that cries wolf gets ignored.
    const { service } = makeService(
      [{ _id: C1, emails: ['John@Acme.COM'], phones: [], omniIdentities: [] }],
      [{ contactId: C1, type: 'email', normalisedValue: 'john@acme.com' }],
    );

    expect((await service.sample()).missing).toBe(0);
  });

  it('should namespace omni identities by channel when comparing', async () => {
    const { service } = makeService(
      [
        {
          _id: C1,
          emails: [],
          phones: [],
          omniIdentities: [{ channelType: 'Facebook', senderId: '123' }],
        },
      ],
      [{ contactId: C1, type: 'omni', normalisedValue: 'facebook:123' }],
    );

    expect((await service.sample()).missing).toBe(0);
  });

  it('should attribute rows to the right contact', async () => {
    // Grouping by contactId is what makes one query serve the whole sample; getting it
    // wrong would report every contact as fully drifted.
    const { service } = makeService(
      [
        { _id: C1, emails: ['a@x.com'], phones: [], omniIdentities: [] },
        { _id: C2, emails: ['b@x.com'], phones: [], omniIdentities: [] },
      ],
      [
        { contactId: C1, type: 'email', normalisedValue: 'a@x.com' },
        { contactId: C2, type: 'email', normalisedValue: 'b@x.com' },
      ],
    );

    const report = await service.sample();
    expect(report.scanned).toBe(2);
    expect(report.missing + report.orphaned).toBe(0);
  });

  it('should skip empty and non-string array entries rather than reporting them', async () => {
    const { service } = makeService(
      [{ _id: C1, emails: ['', null, 'a@x.com'], phones: ['n/a'] }],
      [{ contactId: C1, type: 'email', normalisedValue: 'a@x.com' }],
    );

    expect((await service.sample()).missing).toBe(0);
  });

  it('should cap the samples so one bad batch cannot flood the log', async () => {
    const contacts = Array.from({ length: 20 }, (_, i) => ({
      _id: `id_${i}`,
      emails: [`u${i}@x.com`],
      phones: [],
      omniIdentities: [],
    }));
    const { service } = makeService(contacts, []);

    const report = await service.sample();
    expect(report.missing).toBe(20);
    expect(report.samples.length).toBeLessThanOrEqual(5);
  });

  it('should handle an empty collection without querying identities', async () => {
    const { service, identityModel } = makeService([], []);
    expect(await service.sample()).toEqual({
      scanned: 0,
      missing: 0,
      orphaned: 0,
      samples: [],
    });
    expect(identityModel.find).not.toHaveBeenCalled();
  });
});

describe('ContactIdentityDriftService — cron', () => {
  it('should hold a cluster-singleton lock', async () => {
    // `@Cron` fires in every process that loaded ScheduleModule; without the lock N
    // replicas each run the same scan.
    const { service, lockService } = makeService([], []);
    await service.runDriftCheck();
    expect(lockService.acquire).toHaveBeenCalledWith(
      'cron:contacts:identity-drift',
      expect.objectContaining({ maxRetries: 0 }),
      expect.any(Function),
    );
  });

  it('should never throw out of the cron', async () => {
    // A cron that throws takes the scheduler's error path on every tick; this is a
    // health check, and its failure must not become an incident of its own.
    const { service, lockService } = makeService([], []);
    lockService.acquire.mockRejectedValue(new Error('lock held'));
    await expect(service.runDriftCheck()).resolves.toBeUndefined();
  });

  it('should declare every read as a platform query, or the cron cannot run at all', async () => {
    // The reason this test exists: the two reads had no `isPlatformQuery`, so the
    // tenant plugin threw on the first one and the 05:00 cron reported nothing every
    // night. The unit tests all passed, because a mocked model has no plugin.
    const { service, chains } = makeService(
      [{ _id: C1, emails: ['a@x.com'], phones: [], omniIdentities: [] }],
      [{ contactId: C1, type: 'email', normalisedValue: 'a@x.com' }],
    );

    await service.sample();

    expect(chains).toHaveLength(2);
    for (const q of chains) {
      expect(q.options).toEqual([{ isPlatformQuery: true }]);
    }
  });
});
