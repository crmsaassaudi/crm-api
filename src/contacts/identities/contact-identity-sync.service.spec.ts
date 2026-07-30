import { ConflictException } from '@nestjs/common';
import { ContactIdentitySyncService } from './contact-identity-sync.service';

const CONTACT = '60d0fe4f5311236168a109ca';
const OTHER = '60d0fe4f5311236168a109cb';
const TENANT = '60d0fe4f5311236168a109cc';

function query(rows: any) {
  const chain: any = {
    select: () => chain,
    sort: () => chain,
    limit: () => chain,
    lean: () => chain,
    exec: () => Promise.resolve(rows),
  };
  return chain;
}

function makeHarness(options: { existing?: any[]; conflicts?: any[] } = {}) {
  // Param declared so `bulkWrite.mock.calls[0][0]` is typed — the assertions below
  // read the operations array to prove the reconcile semantics.
  const bulkWrite = jest.fn((_ops: any[], _opts?: unknown) =>
    Promise.resolve({}),
  );
  const updateMany = jest.fn(() => ({ exec: () => Promise.resolve({}) }));
  const updateOne = jest.fn(() => ({ exec: () => Promise.resolve({}) }));

  const model: any = {
    find: jest.fn(() => query(options.existing ?? [])),
    findOne: jest.fn(() => query(null)),
    bulkWrite,
    updateMany,
    updateOne,
  };

  const service = new ContactIdentitySyncService(model, {
    get: (key: string) => (key === 'tenantId' ? TENANT : undefined),
  } as any);

  return { service, model, bulkWrite, updateMany, updateOne };
}

describe('ContactIdentitySyncService — derive', () => {
  it('should normalise emails and phones the same way every write path does', () => {
    const { service } = makeHarness();
    const derived = service.derive(
      { emails: ['John@Acme.COM'], phones: ['+84 90 111 2222'] },
      '84',
    );

    expect(derived).toEqual([
      {
        type: 'email',
        normalisedValue: 'john@acme.com',
        rawValue: 'John@Acme.COM',
      },
      {
        type: 'phone',
        normalisedValue: '+84901112222',
        rawValue: '+84 90 111 2222',
      },
    ]);
  });

  it('should keep the raw value alongside the comparison key', () => {
    // The compacted form is what we compare on; the typed form is what a user
    // recognises. Showing only the former reads as data corruption.
    const { service } = makeHarness();
    const [phone] = service.derive({ phones: ['+84 90 111 2222'] }, '84');
    expect(phone.rawValue).toBe('+84 90 111 2222');
    expect(phone.normalisedValue).not.toBe(phone.rawValue);
  });

  it('should namespace an omni identity by channel', () => {
    // The same numeric id can exist on two providers; a bare senderId would collide
    // two different people into one.
    const { service } = makeHarness();
    const derived = service.derive({
      omniIdentities: [
        { channelType: 'Facebook', senderId: '12345' },
        { channelType: 'Zalo', senderId: '12345' },
      ],
    });
    expect(derived.map((d) => d.normalisedValue)).toEqual([
      'facebook:12345',
      'zalo:12345',
    ]);
  });

  it('should de-duplicate values that normalise to the same key', () => {
    const { service } = makeHarness();
    const derived = service.derive({ emails: ['A@x.com', 'a@X.com'] });
    expect(derived).toHaveLength(1);
  });

  it('should skip empty and non-string entries rather than storing blanks', () => {
    const { service } = makeHarness();
    const derived = service.derive({
      emails: ['', null as any, 'ok@x.com'],
      phones: ['n/a'],
    });
    expect(derived.map((d) => d.normalisedValue)).toEqual(['ok@x.com']);
  });

  it('should be deterministic so an unchanged contact reconciles to nothing', () => {
    const { service } = makeHarness();
    const contact = { emails: ['a@x.com'], phones: ['+1'] };
    expect(service.derive(contact)).toEqual(service.derive(contact));
  });
});

describe('ContactIdentitySyncService strict transactional mode', () => {
  it('should insert rather than upsert so a concurrent owner cannot be stolen', async () => {
    const { service, bulkWrite } = makeHarness({ existing: [] });

    await service.sync(
      CONTACT,
      [{ type: 'email', normalisedValue: 'a@x.com', rawValue: 'a@x.com' }],
      { strict: true, tenantId: TENANT, userId: 'user-1' },
    );

    expect(bulkWrite.mock.calls[0][0][0]).toEqual(
      expect.objectContaining({
        insertOne: {
          document: expect.objectContaining({
            contactId: expect.anything(),
            normalisedValue: 'a@x.com',
          }),
        },
      }),
    );
  });

  it('should propagate a unique-index race so the caller transaction aborts', async () => {
    const { service, bulkWrite } = makeHarness({ existing: [] });
    bulkWrite.mockRejectedValueOnce(new Error('E11000 duplicate key'));

    await expect(
      service.sync(
        CONTACT,
        [{ type: 'email', normalisedValue: 'a@x.com', rawValue: 'a@x.com' }],
        { strict: true, tenantId: TENANT },
      ),
    ).rejects.toThrow(ConflictException);
  });
});

describe('ContactIdentitySyncService — conflicts', () => {
  it('should report which contact already holds the value', async () => {
    // A raw E11000 cannot name the other contact; that message is the whole reason
    // this pre-flight exists alongside the unique index.
    const { service, model } = makeHarness();
    model.find.mockReturnValue(
      query([{ contactId: OTHER, type: 'email', normalisedValue: 'a@x.com' }]),
    );

    const conflicts = await service.findConflicts([
      { type: 'email', normalisedValue: 'a@x.com', rawValue: 'a@x.com' },
    ]);

    expect(conflicts).toEqual([
      { type: 'email', value: 'a@x.com', heldBy: OTHER },
    ]);
  });

  it('should throw a conflict naming the values', async () => {
    const { service, model } = makeHarness();
    model.find.mockReturnValue(
      query([{ contactId: OTHER, type: 'email', normalisedValue: 'a@x.com' }]),
    );

    await expect(
      service.assertNoConflicts([
        { type: 'email', normalisedValue: 'a@x.com', rawValue: 'a@x.com' },
      ]),
    ).rejects.toThrow(ConflictException);
  });

  it('should not query at all for an empty identity set', async () => {
    const { service, model } = makeHarness();
    expect(await service.findConflicts([])).toEqual([]);
    expect(model.find).not.toHaveBeenCalled();
  });
});

describe('ContactIdentitySyncService — reconcile', () => {
  it('should add identities that are new', async () => {
    const { service, bulkWrite } = makeHarness({ existing: [] });
    const result = await service.sync(CONTACT, [
      { type: 'email', normalisedValue: 'a@x.com', rawValue: 'a@x.com' },
    ]);

    expect(result.added).toBe(1);
    expect(bulkWrite).toHaveBeenCalled();
  });

  it('should soft-delete an identity removed from the array', async () => {
    // Reconcile, not append: an email removed from `emails[]` must stop reserving its
    // value in the unique index, or removing then re-adding it would fail.
    const { service, bulkWrite } = makeHarness({
      existing: [{ _id: 'i1', type: 'email', normalisedValue: 'gone@x.com' }],
    });

    const result = await service.sync(CONTACT, []);

    expect(result.removed).toBe(1);
    const ops = bulkWrite.mock.calls[0][0];
    expect(ops[0].updateOne.update.$set.deletedAt).toBeInstanceOf(Date);
  });

  it('should do nothing when the set already matches', async () => {
    // Keeps `updatedAt` meaningful instead of touching every row on every save.
    const { service, bulkWrite } = makeHarness({
      existing: [{ _id: 'i1', type: 'email', normalisedValue: 'a@x.com' }],
    });

    const result = await service.sync(CONTACT, [
      { type: 'email', normalisedValue: 'a@x.com', rawValue: 'a@x.com' },
    ]);

    expect(result).toEqual({ added: 0, removed: 0 });
    expect(bulkWrite).not.toHaveBeenCalled();
  });

  it('should revive a soft-deleted row rather than colliding with it', async () => {
    // Re-adding a previously removed address must not hit the unique index against
    // its own tombstone.
    const { service, bulkWrite } = makeHarness({ existing: [] });
    await service.sync(CONTACT, [
      { type: 'email', normalisedValue: 'back@x.com', rawValue: 'back@x.com' },
    ]);

    const ops = bulkWrite.mock.calls[0][0];
    expect(ops[0].updateOne.update.$set.deletedAt).toBeNull();
    expect(ops[0].updateOne.upsert).toBe(true);
  });

  it('should set immutable defaults only on insert', async () => {
    // A re-sync must not reset a verified flag or a recorded consent answer.
    const { service, bulkWrite } = makeHarness({ existing: [] });
    await service.sync(CONTACT, [
      { type: 'email', normalisedValue: 'a@x.com', rawValue: 'a@x.com' },
    ]);

    const update = bulkWrite.mock.calls[0][0][0].updateOne.update;
    expect(update.$setOnInsert).toMatchObject({ verified: false, optIn: null });
    expect(update.$set.verified).toBeUndefined();
    expect(update.$set.optIn).toBeUndefined();
  });

  it('should NEVER throw — the arrays are already saved and authoritative', async () => {
    // A projection that can fail a contact write is worse than one that lags.
    const { service, model } = makeHarness();
    model.find.mockImplementation(() => {
      throw new Error('mongo down');
    });

    await expect(
      service.sync(CONTACT, [
        { type: 'email', normalisedValue: 'a@x.com', rawValue: 'a@x.com' },
      ]),
    ).resolves.toEqual({ added: 0, removed: 0 });
  });

  it('should skip silently when there is no tenant context', async () => {
    const service = new ContactIdentitySyncService(
      { find: jest.fn(() => query([])) } as any,
      { get: () => undefined } as any,
    );
    expect(await service.sync(CONTACT, [])).toEqual({ added: 0, removed: 0 });
  });
});

describe('ContactIdentitySyncService — primaries', () => {
  it('should demote before promoting, as the unique index requires', async () => {
    const { service, updateMany, updateOne } = makeHarness({ existing: [] });
    await service.sync(CONTACT, [
      {
        type: 'email',
        normalisedValue: 'first@x.com',
        rawValue: 'first@x.com',
      },
      {
        type: 'email',
        normalisedValue: 'second@x.com',
        rawValue: 'second@x.com',
      },
    ]);

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ isPrimary: true }),
      { $set: { isPrimary: false } },
    );
    // The array's FIRST entry becomes primary — the rest of the product already
    // treats emails[0] as "the" email.
    expect(updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ normalisedValue: 'first@x.com' }),
      { $set: { isPrimary: true } },
    );
  });
});

describe('ContactIdentitySyncService — per-identity state', () => {
  it('should record consent against one identity, not the whole contact', async () => {
    // The contact-level boolean could not express "this address opted out but that
    // one did not", which is the shape consent actually takes.
    const { service, updateOne } = makeHarness();
    await service.setConsent('i1', false);

    expect(updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: 'i1' }),
      { $set: { optIn: false, optInAt: expect.any(Date) } },
    );
  });

  it('should clear the timestamp when consent is reset to unknown', async () => {
    // null is "no explicit answer", which is not the same as an explicit refusal.
    const { service, updateOne } = makeHarness();
    await service.setConsent('i1', null);
    expect(updateOne).toHaveBeenCalledWith(expect.anything(), {
      $set: { optIn: null, optInAt: null },
    });
  });

  it('should stamp a bounce so the next campaign can skip the address', async () => {
    const { service, updateOne } = makeHarness();
    await service.setDeliverability('i1', { bounced: true });
    expect(updateOne).toHaveBeenCalledWith(expect.anything(), {
      $set: { bouncedAt: expect.any(Date) },
    });
  });

  it('should not write anything for an empty deliverability update', async () => {
    const { service, updateOne } = makeHarness();
    await service.setDeliverability('i1', {});
    expect(updateOne).not.toHaveBeenCalled();
  });
});
