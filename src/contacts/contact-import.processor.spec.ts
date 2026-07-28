import {
  ContactImportJobData,
  ContactImportProcessor,
} from './contact-import.processor';
import { ImportSummary } from './contact-import-report.service';
import { ImportDedupEngine } from '../common/import/import-dedup.service';

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
  const cls = { set: jest.fn(), get: jest.fn(), runWith: jest.fn() };
  const redis = { get: jest.fn(), set: jest.fn(), del: jest.fn() };
  const importJobModel = { updateOne: jest.fn(() => ({})) };
  const connection = { startSession: jest.fn() };

  // Only `contactModel` is exercised by the methods under test; the rest exist
  // to satisfy construction.
  return new ContactImportProcessor(
    contactModel,
    storageFactory as any,
    lockService as any,
    automationOutbox as any,
    cls as any,
    redis as any,
    importJobModel as any,
    connection as any,
  );
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
    );
    expect(m.arrayFields.phones).toEqual(['+84901112222']);
  });
});

describe('ContactImportProcessor — buildMerge', () => {
  const proc: any = makeProcessor(makeModel());

  it('should fills only empty scalar fields', () => {
    const m = proc.mapRow(
      { 'First Name': 'New', 'Last Name': 'Name', Email: 'x@x.com' },
      { 'First Name': 'firstName', 'Last Name': 'lastName', Email: 'emails' },
      1,
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
    ),
    proc.mapRow(
      { 'First Name': 'C', 'Last Name': 'D', Email: 'c@x.com' },
      baseData().mapping,
      2,
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
      ),
      proc.mapRow(
        { 'First Name': 'C', 'Last Name': 'D', Email: 'dup@x.com' },
        baseData().mapping,
        2,
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
