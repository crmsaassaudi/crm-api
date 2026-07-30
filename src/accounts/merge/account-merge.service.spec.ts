import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { AccountMergeService } from './account-merge.service';
import { Account } from '../domain/account';
import { ACCOUNT_MERGE_REFERENCES } from './account-references.registry';

const SURVIVOR = '60d0fe4f5311236168a109ca';
const LOSER = '60d0fe4f5311236168a109cb';
const TENANT = '60d0fe4f5311236168a109cc';

const account = (id: string, overrides: Partial<Account> = {}): Account =>
  ({
    id,
    tenantId: TENANT,
    name: 'Acme',
    emails: [],
    phones: [],
    tags: [],
    createdById: 'u1',
    updatedById: 'u1',
    createdAt: new Date(),
    updatedAt: new Date(),
    version: 0,
    ...overrides,
  }) as Account;

function makeHarness(
  options: {
    survivor?: Account;
    loser?: Account;
    matchedCount?: number;
    versionConflict?: boolean;
    pairRows?: any[];
    twin?: any;
    failCollections?: string[];
  } = {},
) {
  const survivor = options.survivor ?? account(SURVIVOR);
  const loser = options.loser ?? account(LOSER, { name: 'Acme Ltd' });
  const fail = new Set(options.failCollections ?? []);

  // A single monotonic counter across every mocked write, so ordering assertions
  // compare real sequence numbers rather than the order jest happened to record.
  let seq = 0;
  const updateManyCalls: Array<{
    collection: string;
    filter: any;
    update: any;
    at: number;
  }> = [];
  const updateOne = jest.fn().mockResolvedValue({ modifiedCount: 1 });
  const pairRows = options.pairRows ?? [];
  const twin = options.twin ?? null;

  // The name parameter is declared so `collection.mock.calls` types as `[string]`;
  // the assertions read it to prove which collections a merge touched.
  const collection = jest.fn((name: string) => ({
    updateMany: jest.fn((filter: any, update: any) => {
      if (fail.has(name)) return Promise.reject(new Error('index conflict'));
      updateManyCalls.push({ collection: name, filter, update, at: ++seq });
      return Promise.resolve({ matchedCount: options.matchedCount ?? 2 });
    }),
    updateOne,
    findOne: jest.fn(() => Promise.resolve(twin)),
    countDocuments: jest.fn().mockResolvedValue(3),
    find: () => ({
      limit: () => ({ toArray: () => Promise.resolve(pairRows) }),
      toArray: () => Promise.resolve(pairRows),
    }),
  }));

  const removeOrder: number[] = [];
  const repository = {
    findOne: jest.fn((filter: any) =>
      Promise.resolve(String(filter._id) === SURVIVOR ? survivor : loser),
    ),
    updateWithVersionCheck: jest
      .fn()
      .mockResolvedValue(options.versionConflict ? null : survivor),
    remove: jest.fn(() => {
      removeOrder.push(++seq);
      return Promise.resolve(undefined);
    }),
  };

  const entityAudit = { emit: jest.fn() };
  const events = { emit: jest.fn() };

  const service = new AccountMergeService(
    repository as any,
    // Lock service: run the callback straight through.
    { acquire: jest.fn((_k: string, _t: any, fn: any) => fn()) } as any,
    entityAudit as any,
    {
      get: jest.fn((k: string) =>
        k === 'tenantId' || k === 'activeTenantId' ? TENANT : 'u1',
      ),
    } as any,
    events as any,
    { collection } as any,
  );

  return {
    service,
    repository,
    collection,
    updateManyCalls,
    removeOrder,
    updateOne,
    entityAudit,
    events,
    survivor,
    loser,
  };
}

describe('AccountMergeService.merge', () => {
  it('should re-parent every registered reference BEFORE archiving the loser', async () => {
    const h = makeHarness();
    await h.service.merge(SURVIVOR, LOSER);

    // The ordering is the whole point: reversed, related rows briefly point at an
    // account the UI no longer shows, which is unreachable-not-deleted data.
    const touched = h.updateManyCalls.map((c) => c.collection);
    for (const ref of ACCOUNT_MERGE_REFERENCES) {
      expect(touched).toContain(ref.collection);
    }
    expect(h.repository.remove).toHaveBeenCalledWith(LOSER);

    // Every re-parent must precede the archive, by sequence number.
    expect(h.updateManyCalls.length).toBe(ACCOUNT_MERGE_REFERENCES.length);
    expect(h.removeOrder).toHaveLength(1);
    const lastReparent = Math.max(...h.updateManyCalls.map((c) => c.at));
    expect(lastReparent).toBeLessThan(h.removeOrder[0]);
  });

  it('should never touch the audit trail', async () => {
    const h = makeHarness();
    await h.service.merge(SURVIVOR, LOSER);
    // Rewriting audit rows onto the survivor would falsify history.
    expect(h.updateManyCalls.map((c) => c.collection)).not.toContain(
      'audit_logs',
    );
  });

  it('should reject merging an account into itself', async () => {
    const h = makeHarness();
    await expect(h.service.merge(SURVIVOR, SURVIVOR)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('should 404 rather than merge an account the caller cannot see', async () => {
    const h = makeHarness();
    // The repository applies tenant + visibility scoping, so an invisible account
    // reads as absent. Merge must not be a way around that.
    h.repository.findOne.mockResolvedValueOnce(null as any);
    await expect(h.service.merge(SURVIVOR, LOSER)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('should report a conflict when the survivor changed under the merge', async () => {
    const h = makeHarness({ versionConflict: true });
    await expect(h.service.merge(SURVIVOR, LOSER)).rejects.toThrow(
      ConflictException,
    );
    // And it must NOT archive the loser: both records stay visible, so rerunning
    // the merge is the repair.
    expect(h.repository.remove).not.toHaveBeenCalled();
  });

  it('should pass the survivor version to the optimistic update', async () => {
    const h = makeHarness({ survivor: account(SURVIVOR, { version: 7 }) });
    await h.service.merge(SURVIVOR, LOSER);
    expect(h.repository.updateWithVersionCheck).toHaveBeenCalledWith(
      SURVIVOR,
      7,
      expect.any(Object),
    );
  });

  it('should keep going when one collection fails, and report what moved', async () => {
    const h = makeHarness({ failCollections: ['deals'] });
    const result = await h.service.merge(SURVIVOR, LOSER);

    // A single failing collection must not abandon the merge half-done with no
    // record of it — the returned counts are what makes the damage inspectable.
    expect(result.reparented.deals).toBeUndefined();
    expect(result.reparented.tickets).toBe(2);
    expect(h.repository.remove).toHaveBeenCalledWith(LOSER);
  });

  it('should record the merge in the audit trail and the activity feed', async () => {
    const h = makeHarness();
    await h.service.merge(SURVIVOR, LOSER);

    expect(h.entityAudit.emit).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'ACCOUNT', entityId: SURVIVOR }),
    );
    expect(h.events.emit).toHaveBeenCalledWith(
      'activity.create',
      expect.objectContaining({
        targetType: 'account',
        targetId: SURVIVOR,
        event: 'merge',
      }),
    );
  });

  it('should clear a colliding affiliation row before re-parenting it', async () => {
    // Both accounts employ the same contact: re-parenting the loser's affiliation
    // collides with the survivor's on the unique index, which aborts the whole
    // updateMany rather than skipping the one row.
    const h = makeHarness({
      pairRows: [{ _id: 'rel1', contactId: 'c1' }],
      twin: { _id: 'rel2' },
    });
    await h.service.merge(SURVIVOR, LOSER);

    expect(h.updateOne).toHaveBeenCalledWith(
      { _id: 'rel1' },
      { $set: { deletedAt: expect.any(Date) } },
    );
  });
});

describe('AccountMergeService survivorship', () => {
  it('should fill the survivor blanks without overwriting its values', async () => {
    const h = makeHarness({
      survivor: account(SURVIVOR, { website: 'survivor.com' }),
      loser: account(LOSER, {
        website: 'loser.com',
        industry: 'Technology',
        taxId: '012345678',
      }),
    });
    await h.service.merge(SURVIVOR, LOSER);

    const [, , update] = h.repository.updateWithVersionCheck.mock.calls[0] as [
      string,
      number,
      Record<string, unknown>,
    ];
    // Filled, because the survivor had none.
    expect(update.industry).toBe('Technology');
    expect(update.taxId).toBe('012345678');
    // NOT overwritten. "Fill the blanks" is the only rule that cannot silently
    // destroy data, and it is what people expect a merge to do.
    expect(update.website).toBeUndefined();
  });

  it('should union the ways of reaching the company', async () => {
    const h = makeHarness({
      survivor: account(SURVIVOR, {
        emails: ['a@acme.com'],
        tags: ['VIP'],
      }),
      loser: account(LOSER, {
        emails: ['b@acme.com', 'a@acme.com'],
        phones: ['+18005550000'],
        tags: ['Partner'],
      }),
    });
    await h.service.merge(SURVIVOR, LOSER);

    const update = h.repository.updateWithVersionCheck.mock
      .calls[0][2] as Record<string, unknown>;
    expect(update.emails).toEqual(['a@acme.com', 'b@acme.com']);
    expect(update.phones).toEqual(['+18005550000']);
    expect(update.tags).toEqual(['VIP', 'Partner']);
  });

  it('should re-derive the identity keys when it inherits a website or tax id', async () => {
    // The regression this guards: the survivor gains `website: acme.com` and keeps an
    // empty `websiteDomain`, so it is immediately un-findable as a duplicate of the
    // next record with that domain — right after a human confirmed the domain
    // identifies it.
    const h = makeHarness({
      survivor: account(SURVIVOR, { name: 'Acme Corp' }),
      loser: account(LOSER, {
        website: 'https://www.acme.com/about',
        taxId: '01-2345678',
      }),
    });
    await h.service.merge(SURVIVOR, LOSER);

    const update = h.repository.updateWithVersionCheck.mock
      .calls[0][2] as Record<string, unknown>;
    expect(update.websiteDomain).toBe('acme.com');
    expect(update.taxIdKey).toBe('012345678');
    expect(update.nameKey).toBe('acme');
  });

  it('should not rewrite identity keys when neither source field changed', async () => {
    const h = makeHarness({
      survivor: account(SURVIVOR, { website: 'acme.com', taxId: '111' }),
      loser: account(LOSER, { industry: 'Technology' }),
    });
    await h.service.merge(SURVIVOR, LOSER);

    const update = h.repository.updateWithVersionCheck.mock
      .calls[0][2] as Record<string, unknown>;
    expect(update.websiteDomain).toBeUndefined();
    expect(update.taxIdKey).toBeUndefined();
  });

  it('should prefer the survivor per custom-field key, not per object', async () => {
    const h = makeHarness({
      survivor: account(SURVIVOR, { customFields: { segment: 'Enterprise' } }),
      loser: account(LOSER, {
        customFields: { segment: 'SMB', region: 'APAC' },
      }),
    });
    await h.service.merge(SURVIVOR, LOSER);

    const update = h.repository.updateWithVersionCheck.mock
      .calls[0][2] as Record<string, unknown>;
    // Whole-object survivorship would discard `region`; whole-object inheritance
    // would silently downgrade `segment`.
    expect(update.customFields).toEqual({
      segment: 'Enterprise',
      region: 'APAC',
    });
  });
});

describe('AccountMergeService.preview', () => {
  it('should write nothing', async () => {
    const h = makeHarness();
    await h.service.preview(SURVIVOR, LOSER);

    expect(h.updateManyCalls).toEqual([]);
    expect(h.repository.updateWithVersionCheck).not.toHaveBeenCalled();
    expect(h.repository.remove).not.toHaveBeenCalled();
  });

  it('should report what would move, labelled for a human', async () => {
    const h = makeHarness();
    const preview = await h.service.preview(SURVIVOR, LOSER);

    // Labels, not collection names: "12 deals" is a decision, "12 rows in deals"
    // is trivia.
    expect(Object.keys(preview.willReparent)).toEqual(
      expect.arrayContaining(['deals', 'tickets', 'contacts']),
    );
    expect(preview.survivor).toEqual({ id: SURVIVOR, name: 'Acme' });
    expect(preview.merged).toEqual({ id: LOSER, name: 'Acme Ltd' });
  });

  it('should say what would be discarded, not only what survives', async () => {
    const h = makeHarness({
      survivor: account(SURVIVOR, { website: 'survivor.com' }),
      loser: account(LOSER, { website: 'loser.com' }),
    });
    const preview = await h.service.preview(SURVIVOR, LOSER);

    expect(preview.fieldChoices.website).toEqual({
      chosen: 'survivor.com',
      from: 'survivor',
      discarded: 'loser.com',
    });
  });
});
