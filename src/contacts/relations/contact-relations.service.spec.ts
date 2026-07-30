import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { ContactRelationsService } from './contact-relations.service';

const A = '60d0fe4f5311236168a109ca';
const B = '60d0fe4f5311236168a109cb';
const ACC1 = '60d0fe4f5311236168a109cc';
const ACC2 = '60d0fe4f5311236168a109cd';
const TENANT = '60d0fe4f5311236168a109ce';

/** Chainable Mongoose-query stub resolving to `rows`. */
function query(rows: any[]) {
  const chain: any = {
    sort: () => chain,
    limit: () => chain,
    lean: () => chain,
    exec: () => Promise.resolve(rows),
  };
  return chain;
}

function makeHarness(
  options: {
    relations?: any[];
    affiliations?: any[];
    affiliationCount?: number;
    contactNames?: any[];
    accountNames?: any[];
    missingContact?: string;
  } = {},
) {
  const contacts = {
    findOne: jest.fn((filter: any) =>
      Promise.resolve(
        String(filter._id) === options.missingContact
          ? null
          : { id: String(filter._id), firstName: 'X', lastName: 'Y' },
      ),
    ),
    // Params declared so `update.mock.calls[0][1]` is typed — the mirror test
    // reads the payload to prove `companyName` is not rewritten.
    update: jest.fn((_id: string, _payload: Record<string, unknown>) =>
      Promise.resolve({}),
    ),
  };

  const collections: Record<string, any> = {
    contacts: {
      find: () => ({
        toArray: () => Promise.resolve(options.contactNames ?? []),
      }),
    },
    accounts: {
      find: () => ({
        toArray: () => Promise.resolve(options.accountNames ?? []),
      }),
    },
  };

  const relationModel: any = {
    create: jest.fn((doc: any) =>
      Promise.resolve({ toObject: () => ({ _id: 'rel1', ...doc }) }),
    ),
    findOne: jest.fn(() => query(null as any)),
    find: jest.fn(() => query(options.relations ?? [])),
    updateOne: jest.fn(() => ({
      exec: () => Promise.resolve({ matchedCount: 1 }),
    })),
    db: { collection: (name: string) => collections[name] },
  };

  const affiliationModel: any = {
    create: jest.fn((doc: any) =>
      Promise.resolve({ toObject: () => ({ _id: 'aff1', ...doc }) }),
    ),
    countDocuments: jest.fn(() => ({
      exec: () => Promise.resolve(options.affiliationCount ?? 0),
    })),
    find: jest.fn(() => query(options.affiliations ?? [])),
    findOne: jest.fn(() => query((options.affiliations ?? [])[0] ?? null)),
    findOneAndUpdate: jest.fn(() => query(null as any)),
    updateMany: jest.fn(() => ({ exec: () => Promise.resolve({}) })),
    db: { collection: (name: string) => collections[name] },
  };

  const service = new ContactRelationsService(
    contacts as any,
    { get: jest.fn(() => TENANT) } as any,
    relationModel,
    affiliationModel,
  );

  return { service, contacts, relationModel, affiliationModel };
}

describe('ContactRelationsService — person relations', () => {
  it('should reject relating a contact to itself', async () => {
    const { service } = makeHarness();
    await expect(
      service.addPersonRelation(A, {
        toContactId: A,
        relationType: 'colleague',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('should require a label for a custom relation type', async () => {
    // Otherwise the row renders as "custom" and means nothing to anyone.
    const { service } = makeHarness();
    await expect(
      service.addPersonRelation(A, { toContactId: B, relationType: 'custom' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('should reject an unknown relation type', async () => {
    const { service } = makeHarness();
    await expect(
      service.addPersonRelation(A, {
        toContactId: B,
        relationType: 'nonsense' as any,
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('should read both ends through the repository so visibility applies', async () => {
    // Linking must not be a way to reach — or confirm the existence of — a contact
    // the caller cannot see.
    const { service, contacts } = makeHarness({ missingContact: B });
    await expect(
      service.addPersonRelation(A, {
        toContactId: B,
        relationType: 'colleague',
      }),
    ).rejects.toThrow(NotFoundException);
    expect(contacts.findOne).toHaveBeenCalled();
  });

  it('should refuse a symmetric relation that already exists reversed', async () => {
    // "A colleague B" and "B colleague A" are the same fact, and the ordered-pair
    // unique index cannot catch it.
    const { service, relationModel } = makeHarness();
    relationModel.findOne.mockReturnValue(query({ _id: 'existing' } as any));

    await expect(
      service.addPersonRelation(A, {
        toContactId: B,
        relationType: 'colleague',
      }),
    ).rejects.toThrow(ConflictException);
  });

  it('should allow an asymmetric relation in both directions', async () => {
    // "A reports_to B" and "B reports_to A" are different (wrong, but different)
    // facts — only symmetric types get the mirror check.
    const { service, relationModel } = makeHarness();
    await service.addPersonRelation(A, {
      toContactId: B,
      relationType: 'reports_to',
    });
    expect(relationModel.findOne).not.toHaveBeenCalled();
    expect(relationModel.create).toHaveBeenCalled();
  });

  it('should translate a duplicate-key error into a clear conflict', async () => {
    const { service, relationModel } = makeHarness();
    relationModel.create.mockRejectedValue({ code: 11000 });
    await expect(
      service.addPersonRelation(A, {
        toContactId: B,
        relationType: 'reports_to',
      }),
    ).rejects.toThrow(ConflictException);
  });

  it('should invert the label when read from the other end', async () => {
    // One row, two readings: A reports_to B; from B the same row is a direct report.
    const { service } = makeHarness({
      relations: [
        {
          _id: 'r1',
          fromContactId: A,
          toContactId: B,
          relationType: 'reports_to',
        },
      ],
      contactNames: [{ _id: A, firstName: 'Alice', lastName: 'N' }],
    });

    const [entry] = await service.listPersonRelations(B);
    expect(entry.relationLabel).toBe('direct_report');
    expect(entry.isOutgoing).toBe(false);
    expect(entry.contactId).toBe(A);
    expect(entry.contactName).toBe('Alice N');
  });

  it('should keep the stored label when read from the subject end', async () => {
    const { service } = makeHarness({
      relations: [
        {
          _id: 'r1',
          fromContactId: A,
          toContactId: B,
          relationType: 'reports_to',
        },
      ],
      contactNames: [{ _id: B, firstName: 'Bob', lastName: 'M' }],
    });

    const [entry] = await service.listPersonRelations(A);
    expect(entry.relationLabel).toBe('reports_to');
    expect(entry.isOutgoing).toBe(true);
  });

  it('should soft-delete rather than remove a relation', async () => {
    const { service, relationModel } = makeHarness();
    await service.removePersonRelation('r1');
    expect(relationModel.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: 'r1' }),
      { $set: { deletedAt: expect.any(Date) } },
    );
  });
});

describe('ContactRelationsService — affiliations', () => {
  it('should make the FIRST affiliation primary regardless of the flag', async () => {
    // Otherwise a contact ends up with a company and a null accountId — exactly
    // the inconsistency this model exists to remove.
    const { service, affiliationModel } = makeHarness({ affiliationCount: 0 });
    await service.addAffiliation(A, { accountId: ACC1, isPrimary: false });
    expect(affiliationModel.create).toHaveBeenCalledWith(
      expect.objectContaining({ isPrimary: true }),
    );
  });

  it('should NOT auto-promote a second affiliation', async () => {
    const { service, affiliationModel } = makeHarness({ affiliationCount: 1 });
    await service.addAffiliation(A, { accountId: ACC2 });
    expect(affiliationModel.create).toHaveBeenCalledWith(
      expect.objectContaining({ isPrimary: false }),
    );
  });

  it('should demote the existing primary before promoting a new one', async () => {
    // The partial unique index rejects two primaries, so the other order fails.
    const { service, affiliationModel } = makeHarness({ affiliationCount: 1 });
    await service.addAffiliation(A, { accountId: ACC2, isPrimary: true });
    expect(affiliationModel.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ isPrimary: true }),
      { $set: { isPrimary: false } },
    );
  });

  it('should mirror the primary onto contact.accountId', async () => {
    // The backward-compatibility seam: every existing report, export column and
    // automation condition reads accountId and knows nothing about this collection.
    const { service, contacts } = makeHarness({ affiliationCount: 0 });
    await service.addAffiliation(A, { accountId: ACC1 });
    expect(contacts.update).toHaveBeenCalledWith(
      A,
      expect.objectContaining({ accountId: ACC1 }),
    );
  });

  it('should NOT touch companyName when mirroring', async () => {
    // It is free text a user may have deliberately set to something else;
    // rewriting it would be a data change disguised as a sync.
    const { service, contacts } = makeHarness({ affiliationCount: 0 });
    await service.addAffiliation(A, { accountId: ACC1 });
    const payload = contacts.update.mock.calls[0][1];
    expect(payload).not.toHaveProperty('companyName');
  });

  it('should reject a duplicate affiliation with a usable message', async () => {
    const { service, affiliationModel } = makeHarness({ affiliationCount: 1 });
    affiliationModel.create.mockRejectedValue({ code: 11000 });
    await expect(
      service.addAffiliation(A, { accountId: ACC1 }),
    ).rejects.toThrow(ConflictException);
  });

  it('should mark an ended affiliation as not current but keep it', async () => {
    // "Who used to work at Acme" has to stay answerable.
    const { service } = makeHarness({
      affiliations: [
        {
          _id: 'aff1',
          accountId: ACC1,
          isPrimary: false,
          endedAt: new Date('2026-01-01'),
        },
      ],
      accountNames: [{ _id: ACC1, name: 'Acme' }],
    });

    const [entry] = await service.listAffiliations(A);
    expect(entry.isCurrent).toBe(false);
    expect(entry.accountName).toBe('Acme');
  });

  it('should promote the next affiliation when the primary is removed', async () => {
    // Leaving contact.accountId pointing at a company the person is no longer
    // linked to would be worse than having no primary at all.
    const { service, affiliationModel, contacts } = makeHarness();
    affiliationModel.findOneAndUpdate
      .mockReturnValueOnce(
        query({ _id: 'aff1', contactId: A, isPrimary: true } as any),
      )
      .mockReturnValueOnce(query({ _id: 'aff2', accountId: ACC2 } as any));

    await service.removeAffiliation('aff1');

    expect(contacts.update).toHaveBeenCalledWith(
      A,
      expect.objectContaining({ accountId: ACC2 }),
    );
  });

  it('should clear contact.accountId when the last affiliation goes', async () => {
    const { service, affiliationModel, contacts } = makeHarness();
    affiliationModel.findOneAndUpdate
      .mockReturnValueOnce(
        query({ _id: 'aff1', contactId: A, isPrimary: true } as any),
      )
      .mockReturnValueOnce(query(null as any));

    await service.removeAffiliation('aff1');

    expect(contacts.update).toHaveBeenCalledWith(
      A,
      expect.objectContaining({ accountId: null }),
    );
  });

  it('should not touch the mirror when a NON-primary affiliation is removed', async () => {
    const { service, affiliationModel, contacts } = makeHarness();
    affiliationModel.findOneAndUpdate.mockReturnValueOnce(
      query({ _id: 'aff2', contactId: A, isPrimary: false } as any),
    );

    await service.removeAffiliation('aff2');
    expect(contacts.update).not.toHaveBeenCalled();
  });

  it('should 404 on removing an affiliation that is already gone', async () => {
    const { service, affiliationModel } = makeHarness();
    affiliationModel.findOneAndUpdate.mockReturnValue(query(null as any));
    await expect(service.removeAffiliation('nope')).rejects.toThrow(
      NotFoundException,
    );
  });
});
