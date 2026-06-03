import {
  ContactImportJobData,
  ContactImportProcessor,
} from './contact-import.processor';
import { ImportSummary } from './contact-import-report.service';

/** Minimal report-writer stub capturing appended errors. */
function makeReport() {
  const errors: any[] = [];
  return {
    appendErrors: jest.fn(async (e: any[]) => errors.push(...e)),
    discard: jest.fn(async () => undefined),
    finalize: jest.fn(async () => null),
    get count() {
      return errors.length;
    },
    errors,
  };
}

function makeModel(existingDocs: any[] = []) {
  const chain: any = {
    select: () => chain,
    lean: () => chain,
    exec: async () => existingDocs,
  };
  return {
    find: jest.fn(() => chain),
    bulkWrite: jest.fn(async () => ({ insertedCount: 0, modifiedCount: 0 })),
  };
}

function makeProcessor(model: any) {
  // Only model is exercised by the methods under test; the rest are stubs.
  return new ContactImportProcessor(
    model,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    { set: jest.fn(), get: jest.fn(), runWith: jest.fn() } as any,
    {} as any,
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

describe('ContactImportProcessor — mapping', () => {
  const proc: any = makeProcessor(makeModel());

  it('maps scalar + array fields and normalizes', () => {
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
    expect(m.fields.firstName).toBe('Alice');
    expect(m.emails).toEqual(['a@x.com', 'b@x.com']);
    expect(m.phones).toEqual(['0901234567']);
  });

  it('keeps a leading + on phone numbers', () => {
    const m = proc.mapRow(
      { 'First Name': 'A', 'Last Name': 'B', Phone: '+84 90 111 2222' },
      baseData().mapping,
      1,
    );
    expect(m.phones).toEqual(['+84901112222']);
  });
});

describe('ContactImportProcessor — buildMerge', () => {
  const proc: any = makeProcessor(makeModel());

  it('fills only empty scalar fields', () => {
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

  it('warns on conflicting email when multiple disabled', () => {
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

  it('appends new emails via $addToSet when multiple allowed', () => {
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
  const dedup = ['emails'] as ('emails' | 'phones')[];

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

  it('inserts new contacts with createdById/updatedById populated', async () => {
    const model = makeModel([]);
    const proc: any = makeProcessor(model);
    const summary = emptySummary();
    await proc.processBatch(
      rows(proc),
      baseData(),
      dedup,
      'merge',
      new Set(),
      summary,
      makeReport(),
      false,
    );
    expect(summary.inserted).toBe(2);
    const call = (model.bulkWrite as jest.Mock).mock.calls[0] as any[];
    const ops = call[0];
    expect(ops).toHaveLength(2);
    expect(ops[0].insertOne.document.createdById).toBe('u1');
    expect(ops[0].insertOne.document.updatedById).toBe('u1');
    expect(call[1]).toEqual({ ordered: false });
  });

  it('skips duplicates under the skip policy', async () => {
    const model = makeModel([{ _id: '1', emails: ['a@x.com'] }]);
    const proc: any = makeProcessor(model);
    const summary = emptySummary();
    await proc.processBatch(
      rows(proc),
      baseData(),
      dedup,
      'skip',
      new Set(),
      summary,
      makeReport(),
      false,
    );
    // a@x.com matches existing → skipped; c@x.com is new → inserted.
    expect(summary.skipped).toBe(1);
    expect(summary.inserted).toBe(1);
  });

  it('dry-run performs zero writes', async () => {
    const model = makeModel([]);
    const proc: any = makeProcessor(model);
    const summary = emptySummary();
    await proc.processBatch(
      rows(proc),
      baseData(),
      dedup,
      'merge',
      new Set(),
      summary,
      makeReport(),
      true,
    );
    expect(model.bulkWrite).not.toHaveBeenCalled();
    expect(summary.inserted).toBe(2);
  });

  it('flags rows missing required fields and excludes them', async () => {
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
      dedup,
      'merge',
      new Set(),
      summary,
      report,
      false,
    );
    expect(summary.errors).toBe(1);
    expect(summary.inserted).toBe(0);
    expect(report.errors[0]).toMatchObject({ row: 1 });
  });

  it('de-duplicates rows within the same file', async () => {
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
      dedup,
      'merge',
      new Set(),
      summary,
      makeReport(),
      false,
    );
    expect(summary.inserted).toBe(1);
    expect(summary.skipped).toBe(1);
  });
});
