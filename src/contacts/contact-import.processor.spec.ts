import {
  ContactImportJobData,
  ContactImportProcessor,
} from './contact-import.processor';
import { ImportSummary } from './contact-import-report.service';
import { ImportDedupEngine } from '../common/import/import-dedup.service';
import { ImportJobSchema as RegisteredContactImportJobSchema } from './infrastructure/persistence/document/entities/import-job.schema';

/** Minimal report-writer stub capturing appended errors. */
function makeReport() {
  const errors: any[] = [];
  return {
    appendErrors: jest.fn((e: any[]) => errors.push(...e)),
    discard: jest.fn(() => undefined),
    finalize: jest.fn(() => null),
    get count() {
      return errors.length;
    },
    errors,
  };
}

function makeModel(existingDocs: any[] = []) {
  const model: any = {
    bulkWrite: jest.fn(() => ({ insertedCount: 0, modifiedCount: 0 })),
  };
  model.find = jest.fn((filter: any) => {
    const chain: any = {
      select: () => chain,
      session: () => chain,
      lean: () => chain,
      exec: () => {
        if (!filter?._id) return existingDocs;
        const ops = model.bulkWrite.mock.calls.at(-1)?.[0] ?? [];
        return ops.map((op: any) => op.insertOne?.document).filter(Boolean);
      },
    };
    return chain;
  });
  return model;
}

/**
 * Object-storage stub. The constructor calls `storageFactory.create()` eagerly
 * to build its report service, so this one cannot be an empty object — passing
 * `{}` was what produced "this.storageFactory.create is not a function".
 */
function makeStorageFactory() {
  return {
    create: jest.fn(() => ({
      getObjectStream: jest.fn(),
      putObject: jest.fn(),
      deleteObject: jest.fn(),
    })),
  };
}

function makeProcessor(model: any) {
  // Named locals rather than a row of positional `{} as any` stubs. The previous
  // version was silently one position out of step from argument 5 onward,
  // because `eventEmitter` had been inserted into the constructor and every
  // stub is cast to `any` — so TypeScript could not object, and the CLS mock
  // ended up being injected as the Redis client. Naming them means the next
  // signature change is a compile error or an obvious mismatch here, not a
  // mystery at runtime.
  const contactModel = model;
  const storageFactory = makeStorageFactory();
  const lockService = { acquire: jest.fn(), release: jest.fn() };
  const automationOutbox: any = {
    runWithEvents: jest.fn(async (mutate: any) => {
      const { result, payloads } = await mutate({ id: 'session' });
      automationOutbox.payloads = payloads;
      return result;
    }),
  };
  const identitySync = { syncManyFromContacts: jest.fn() };
  const cls = { set: jest.fn(), get: jest.fn(), runWith: jest.fn() };
  const redis = { get: jest.fn(), set: jest.fn(), del: jest.fn() };
  const importJobModel = {
    updateOne: jest.fn(() => Promise.resolve({ matchedCount: 1 })),
    findOne: jest.fn(() => {
      const chain: any = {
        select: () => chain,
        lean: () => chain,
        exec: () => Promise.resolve(null),
      };
      return chain;
    }),
  };
  const connection = { startSession: jest.fn() };

  // Only `contactModel` is exercised by the methods under test; the rest exist
  // to satisfy construction.
  const processor = new ContactImportProcessor(
    contactModel,
    storageFactory as any,
    lockService as any,
    automationOutbox as any,
    identitySync as any,
    cls as any,
    redis as any,
    importJobModel as any,
    connection as any,
  );
  (processor as any).__identitySync = identitySync;
  (processor as any).__importJobModel = importJobModel;
  return processor;
}

const baseData = (
  overrides: Partial<ContactImportJobData> = {},
): ContactImportJobData => ({
  tenantId: 't1',
  userId: 'u1',
  fileKey: 'imports/contacts/x.csv',
  mapping: {
    'First Name': 'firstName',
    'Last Name': 'lastName',
    Email: 'emails',
    Phone: 'phones',
  },
  tenantSettings: {
    uniqueEmail: true,
    uniquePhone: true,
    multipleEmailsAllowed: false,
    multiplePhonesAllowed: false,
  },
  ...overrides,
});

const emptySummary = (): ImportSummary => ({
  total: 0,
  inserted: 0,
  updated: 0,
  skipped: 0,
  errors: 0,
});

describe('registered Contact import-job schema', () => {
  it('should persist every field required for crash-safe resume', () => {
    expect(
      RegisteredContactImportJobSchema.path('checkpointRow'),
    ).toBeDefined();
    expect(
      RegisteredContactImportJobSchema.path('checkpointSummary'),
    ).toBeDefined();
    expect(
      RegisteredContactImportJobSchema.path('projectionPendingIds'),
    ).toBeDefined();
  });
});

describe('ContactImportProcessor identity projection', () => {
  it('should project every successfully written contact in the batch', async () => {
    const model = makeModel();
    model.find = jest.fn(() => {
      const chain: any = {
        select: () => chain,
        lean: () => chain,
        exec: () =>
          Promise.resolve([
            {
              _id: '60d0fe4f5311236168a109ca',
              emails: ['person@example.com'],
              phones: ['+15551234567'],
            },
          ]),
      };
      return chain;
    });
    const processor = makeProcessor(model) as any;

    await processor.afterBatchWrite(
      [
        {
          id: '60d0fe4f5311236168a109ca',
          type: 'insert',
          row: 1,
        },
      ],
      baseData(),
    );

    expect(processor.__identitySync.syncManyFromContacts).toHaveBeenCalledWith(
      [
        {
          contactId: '60d0fe4f5311236168a109ca',
          contact: expect.objectContaining({ emails: ['person@example.com'] }),
        },
      ],
      expect.objectContaining({
        source: 'import',
        tenantId: 't1',
        userId: 'u1',
      }),
    );
  });
});

describe('ContactImportProcessor resumable batch checkpoint', () => {
  const contactId = '60d0fe4f5311236168a109ca';

  function executionArgs() {
    const summary = {
      total: 1,
      inserted: 1,
      updated: 0,
      skipped: 0,
      errors: 0,
    };
    return [
      [
        {
          insertOne: {
            document: {
              _id: contactId,
              tenantId: 't1',
              firstName: 'Alice',
              lastName: 'Smith',
              emails: ['alice@example.com'],
              phones: [],
            },
          },
        },
      ],
      [{ row: 1, type: 'insert' }],
      [{ id: contactId, row: 1, type: 'insert' }],
      baseData(),
      {
        summary,
        report: makeReport(),
        dryRun: false,
        bullJobId: 'job-1',
      },
      [],
      1,
    ] as const;
  }

  it('should commit checkpoint and pending projection receipt in the entity transaction', async () => {
    const proc: any = makeProcessor(makeModel());

    await proc.executeBatchOps(...executionArgs());

    expect(proc.__importJobModel.updateOne).toHaveBeenCalledWith(
      { bullJobId: 'job-1', tenantId: 't1' },
      {
        $set: expect.objectContaining({
          checkpointRow: 1,
          projectionPendingIds: [contactId],
        }),
      },
      { session: { id: 'session' } },
    );
    expect(proc.__identitySync.syncManyFromContacts).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ strict: true, tenantId: 't1' }),
    );
    expect(proc.__importJobModel.updateOne).toHaveBeenCalledWith(
      { bullJobId: 'job-1', tenantId: 't1' },
      { $set: { projectionPendingIds: [] } },
    );
  });

  it('should leave the durable pending receipt when identity projection fails', async () => {
    const proc: any = makeProcessor(makeModel());
    proc.__identitySync.syncManyFromContacts.mockRejectedValueOnce(
      new Error('identity index unavailable'),
    );

    await expect(proc.executeBatchOps(...executionArgs())).rejects.toThrow(
      'identity index unavailable',
    );

    const updates = proc.__importJobModel.updateOne.mock.calls.map(
      (call: any[]) => call[1]?.$set?.projectionPendingIds,
    );
    expect(updates).toContainEqual([contactId]);
    expect(updates).not.toContainEqual([]);
  });

  it('should abort the whole Contact batch instead of salvaging partial rows', async () => {
    const model = makeModel();
    model.bulkWrite.mockRejectedValueOnce({
      writeErrors: [{ index: 0, code: 11000 }],
    });
    const proc: any = makeProcessor(model);

    await expect(proc.executeBatchOps(...executionArgs())).rejects.toEqual(
      expect.objectContaining({ writeErrors: expect.any(Array) }),
    );
    expect(model.bulkWrite).toHaveBeenCalledTimes(1);
    expect(proc.__importJobModel.updateOne).not.toHaveBeenCalled();
  });
});

/**
 * `processBatch` takes a context object, not the eight positional arguments this
 * suite was written against. The dedup fields / policy / seen-key set that used
 * to be separate parameters now live inside ImportDedupEngine + DedupConfig, and
 * the engine keeps the within-file claimed-key state that `new Set()` used to
 * stand in for — so one engine must be shared across a run, exactly as the real
 * processor does.
 */
function makeContext(
  overrides: {
    matchingFields?: string[];
    policy?: string;
    summary?: ImportSummary;
    report?: ReturnType<typeof makeReport>;
    dryRun?: boolean;
    dedupEngine?: ImportDedupEngine;
  } = {},
) {
  return {
    dedupEngine: overrides.dedupEngine ?? new ImportDedupEngine(),
    dedupConfig: {
      matchingFields: overrides.matchingFields ?? ['emails'],
      policy: (overrides.policy ?? 'merge') as any,
    },
    refResolver: undefined,
    summary: overrides.summary ?? emptySummary(),
    report: (overrides.report ?? makeReport()) as any,
    dryRun: overrides.dryRun ?? false,
  };
}

describe('ContactImportProcessor — mapping', () => {
  const proc: any = makeProcessor(makeModel());

  it('should maps scalar + array fields and normalizes', () => {
    const m = proc.mapRow(
      {
        'First Name': 'Alice',
        'Last Name': 'Smith',
        Email: 'A@X.com; b@x.com',
        Phone: '(090) 123-4567',
      },
      baseData().mapping,
      1,
      baseData(),
    );
    // `mapRow` returns { row, fields, arrayFields }. Multi-value columns live
    // under `arrayFields`, not at the top level — the assertions below used to
    // read `m.emails` and silently compared undefined.
    expect(m.fields.firstName).toBe('Alice');
    expect(m.arrayFields.emails).toEqual(['a@x.com', 'b@x.com']);
    expect(m.arrayFields.phones).toEqual(['0901234567']);
  });

  it('should keeps a leading + on phone numbers', () => {
    const m = proc.mapRow(
      { 'First Name': 'A', 'Last Name': 'B', Phone: '+84 90 111 2222' },
      baseData().mapping,
      1,
      baseData(),
    );
    expect(m.arrayFields.phones).toEqual(['+84901112222']);
  });
});

describe('ContactImportProcessor — validation', () => {
  const proc: any = makeProcessor(makeModel());

  it('should reject malformed email and phone identities', () => {
    const mapped = proc.mapRow(
      {
        'First Name': 'Alice',
        'Last Name': 'Smith',
        Email: 'not-an-email',
        Phone: '123',
      },
      baseData().mapping,
      9,
      baseData(),
    );

    expect(proc.validateRow(mapped, baseData())).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ row: 9, field: 'emails' }),
        expect.objectContaining({ row: 9, field: 'phones' }),
      ]),
    );
  });

  it('should reject oversized scalar fields before writing to Mongo', () => {
    const mapped = proc.mapRow(
      { 'First Name': 'A'.repeat(201), 'Last Name': 'Smith' },
      baseData().mapping,
      4,
      baseData(),
    );

    expect(proc.validateRow(mapped, baseData())).toContainEqual(
      expect.objectContaining({ row: 4, field: 'firstName' }),
    );
  });

  it('should accept normalised valid identities', () => {
    const mapped = proc.mapRow(
      {
        'First Name': 'Alice',
        'Last Name': 'Smith',
        Email: 'Alice@Example.com',
        Phone: '+84 90 111 2222',
      },
      baseData().mapping,
      1,
      baseData(),
    );

    expect(proc.validateRow(mapped, baseData())).toEqual([]);
  });
});

describe('ContactImportProcessor — buildMerge', () => {
  const proc: any = makeProcessor(makeModel());

  it('should fills only empty scalar fields', () => {
    const m = proc.mapRow(
      { 'First Name': 'New', 'Last Name': 'Name', Email: 'x@x.com' },
      { 'First Name': 'firstName', 'Last Name': 'lastName', Email: 'emails' },
      1,
      baseData(),
    );
    const errors: any[] = [];
    const update = proc.buildMerge(
      m,
      { firstName: 'Existing', lastName: '', emails: [] },
      baseData(),
      errors,
    );
    // firstName already present → not overwritten; lastName empty → filled.
    expect(update.$set.firstName).toBeUndefined();
    expect(update.$set.lastName).toBe('Name');
    // existing emails empty → filled with first incoming.
    expect(update.$set.emails).toEqual(['x@x.com']);
  });

  it('should warns on conflicting email when multiple disabled', () => {
    const m = proc.mapRow(
      { 'First Name': 'A', 'Last Name': 'B', Email: 'new@x.com' },
      { 'First Name': 'firstName', 'Last Name': 'lastName', Email: 'emails' },
      7,
      baseData(),
    );
    const errors: any[] = [];
    const update = proc.buildMerge(
      m,
      { firstName: 'A', lastName: 'B', emails: ['old@x.com'] },
      baseData(),
      errors,
    );
    expect(errors[0]).toMatchObject({ row: 7, field: 'emails' });
    // No array change because the single slot is taken by a different value.
    expect(update?.$addToSet).toBeUndefined();
  });

  it('should appends new emails via $addToSet when multiple allowed', () => {
    const m = proc.mapRow(
      { 'First Name': 'A', 'Last Name': 'B', Email: 'new@x.com' },
      { 'First Name': 'firstName', 'Last Name': 'lastName', Email: 'emails' },
      1,
      baseData(),
    );
    const data = baseData();
    data.tenantSettings.multipleEmailsAllowed = true;
    const update = proc.buildMerge(
      m,
      { firstName: 'A', lastName: 'B', emails: ['old@x.com'] },
      data,
      [],
    );
    expect(update.$addToSet.emails).toEqual({ $each: ['new@x.com'] });
  });
});

describe('ContactImportProcessor — processBatch', () => {
  const _dedup = ['emails'] as ('emails' | 'phones')[];

  const rows = (proc: any) => [
    proc.mapRow(
      { 'First Name': 'A', 'Last Name': 'B', Email: 'a@x.com' },
      baseData().mapping,
      1,
      baseData(),
    ),
    proc.mapRow(
      { 'First Name': 'C', 'Last Name': 'D', Email: 'c@x.com' },
      baseData().mapping,
      2,
      baseData(),
    ),
  ];

  it('should inserts new contacts with createdById/updatedById populated', async () => {
    const model = makeModel([]);
    const proc: any = makeProcessor(model);
    const summary = emptySummary();
    await proc.processBatch(
      rows(proc),
      baseData(),
      makeContext({
        policy: 'merge',
        summary: summary,
        dryRun: false,
      }),
    );
    expect(summary.inserted).toBe(2);
    const call = (model.bulkWrite as jest.Mock).mock.calls[0] as any[];
    const ops = call[0];
    expect(ops).toHaveLength(2);
    expect(ops[0].insertOne.document.createdById).toBe('u1');
    expect(ops[0].insertOne.document.updatedById).toBe('u1');
    expect(call[1]).toEqual({
      ordered: false,
      session: { id: 'session' },
    });
  });

  it('should atomically capture hydrated automation events for imported rows', async () => {
    const model = makeModel([]);
    const proc: any = makeProcessor(model);
    await proc.processBatch(
      rows(proc),
      baseData({ triggerAutomations: true }),
      makeContext({
        policy: 'merge',
        summary: emptySummary(),
        dryRun: false,
      }),
    );

    const outbox = proc.automationOutbox;
    expect(outbox.payloads).toHaveLength(2);
    expect(outbox.payloads[0]).toEqual(
      expect.objectContaining({
        tenantId: 't1',
        event: 'record_created',
        object: 'Contact',
        triggerUserId: 'u1',
        data: expect.objectContaining({
          firstName: 'A',
          lastName: 'B',
        }),
      }),
    );
  });

  it('should skips duplicates under the skip policy', async () => {
    const model = makeModel([{ _id: '1', emails: ['a@x.com'] }]);
    const proc: any = makeProcessor(model);
    const summary = emptySummary();
    await proc.processBatch(
      rows(proc),
      baseData(),
      makeContext({
        policy: 'skip',
        summary: summary,
        dryRun: false,
      }),
    );
    // a@x.com matches existing → skipped; c@x.com is new → inserted.
    expect(summary.skipped).toBe(1);
    expect(summary.inserted).toBe(1);
  });

  it('should dry-run performs zero writes', async () => {
    const model = makeModel([]);
    const proc: any = makeProcessor(model);
    const summary = emptySummary();
    await proc.processBatch(
      rows(proc),
      baseData(),
      makeContext({
        policy: 'merge',
        summary: summary,
        dryRun: true,
      }),
    );
    expect(model.bulkWrite).not.toHaveBeenCalled();
    expect(summary.inserted).toBe(2);
  });

  it('should flags rows missing required fields and excludes them', async () => {
    const model = makeModel([]);
    const proc: any = makeProcessor(model);
    const summary = emptySummary();
    const report = makeReport();
    const batch = [
      proc.mapRow(
        { 'First Name': 'A', Email: 'a@x.com' }, // no lastName
        baseData().mapping,
        1,
        baseData(),
      ),
    ];
    await proc.processBatch(
      batch,
      baseData(),
      makeContext({
        policy: 'merge',
        summary: summary,
        dryRun: false,
        report: report,
      }),
    );
    expect(summary.errors).toBe(1);
    expect(summary.inserted).toBe(0);
    expect(report.errors[0]).toMatchObject({ row: 1 });
  });

  it('should de-duplicates rows within the same file', async () => {
    const model = makeModel([]);
    const proc: any = makeProcessor(model);
    const summary = emptySummary();
    const batch = [
      proc.mapRow(
        { 'First Name': 'A', 'Last Name': 'B', Email: 'dup@x.com' },
        baseData().mapping,
        1,
        baseData(),
      ),
      proc.mapRow(
        { 'First Name': 'C', 'Last Name': 'D', Email: 'dup@x.com' },
        baseData().mapping,
        2,
        baseData(),
      ),
    ];
    await proc.processBatch(
      batch,
      baseData(),
      makeContext({
        policy: 'merge',
        summary: summary,
        dryRun: false,
      }),
    );
    expect(summary.inserted).toBe(1);
    expect(summary.skipped).toBe(1);
  });
});
