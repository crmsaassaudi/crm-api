import mongoose, { Schema } from 'mongoose';
import { searchKeysPlugin } from './search-keys.plugin';
import { searchKeysClause } from './search-keys.query';

/**
 * Every write path must leave `searchKeys` describing the document as it now is.
 *
 * Runs against a real MongoDB, not a mocked model: what these cases pin is what
 * the driver does with a write. A mock of `Model.bulkWrite` would be written to
 * run middleware — exactly what the real one does not do — and stay green while
 * the importer produces unfindable records. Each case asserts what a user would
 * notice (can search find it?), not just the stored array.
 *
 *   cd crm-opensearch && npm run test:it:up   # or any Mongo via IT_MONGO_URI
 *   cd crm-api && npm run test:search:it
 */
const URI =
  process.env.IT_MONGO_URI ?? 'mongodb://127.0.0.1:27018/crm_it_search_keys';

jest.setTimeout(120_000);

const TENANT = 'tenant-a';

interface ProbeDoc {
  _id: any;
  tenantId: string;
  title?: string;
  accountName?: string;
  tags?: string[];
  emails?: string[];
  searchKeys?: string[];
  searchKeysPii?: string[];
}

describe('searchKeysPlugin write paths', () => {
  let model: mongoose.Model<any>;

  beforeAll(async () => {
    await mongoose.connect(URI, { serverSelectionTimeoutMS: 10_000 });

    const schema = new Schema(
      {
        tenantId: { type: String, required: true },
        title: String,
        accountName: String,
        tags: [String],
        emails: [String],
      },
      { collection: 'it_search_keys_docs' },
    );
    schema.plugin(searchKeysPlugin, {
      fields: ['title', 'accountName', 'tags'],
      sensitiveFields: ['emails'],
    });
    model = mongoose.model('ItSearchKeysDoc', schema);
  });

  afterAll(async () => {
    await model.collection.drop().catch(() => undefined);
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await model.collection.deleteMany({ tenantId: TENANT });
  });

  /** Reads through the driver: what is actually stored, not what Mongoose maps. */
  const stored = async (id: any): Promise<ProbeDoc> =>
    (await model.collection.findOne({ _id: id })) as any;

  /** Counts documents the list-search clause would return for `term`. */
  const findable = async (
    term: string,
    options?: { includeSensitive?: boolean },
  ): Promise<number> => {
    const clause = searchKeysClause(term, options) as Record<string, unknown>;
    return model.collection.countDocuments({ tenantId: TENANT, ...clause });
  };

  it('should index a document written with save()', async () => {
    const doc = await model.create({
      tenantId: TENANT,
      title: 'Alpha',
      accountName: 'Acme',
    });

    expect((await stored(doc._id)).searchKeys).toEqual(['acme', 'alpha']);
    await expect(findable('alpha')).resolves.toBe(1);
  });

  it('should index a document inserted through bulkWrite — the importer path', async () => {
    const id = new mongoose.Types.ObjectId();
    await model.bulkWrite([
      {
        insertOne: {
          document: { _id: id, tenantId: TENANT, title: 'Beta Corp' },
        },
      },
    ] as any);

    expect((await stored(id)).searchKeys).toEqual(['beta', 'corp']);
    // The assertion that matters: a 50k-row import that lands in the database
    // and cannot be found is indistinguishable, to the user, from a failed one.
    await expect(findable('beta')).resolves.toBe(1);
  });

  it('should re-index from the merged document on a bulkWrite updateOne', async () => {
    const doc = await model.create({
      tenantId: TENANT,
      title: 'Gamma',
      accountName: 'Acme',
    });

    await model.bulkWrite([
      {
        updateOne: {
          filter: { _id: doc._id },
          update: { $set: { title: 'Gamma Renamed' } },
        },
      },
    ] as any);

    // `accountName` was not in the update and must survive the recomputation.
    expect((await stored(doc._id)).searchKeys).toEqual([
      'acme',
      'gamma',
      'renamed',
    ]);
    await expect(findable('renamed')).resolves.toBe(1);
    await expect(findable('acme')).resolves.toBe(1);
  });

  it('should re-index every document an updateMany $set matched, and drop the old value', async () => {
    const first = await model.create({
      tenantId: TENANT,
      title: 'Deal one',
      accountName: 'Acme',
    });
    const second = await model.create({
      tenantId: TENANT,
      title: 'Deal two',
      accountName: 'Acme',
    });

    await model.updateMany(
      { tenantId: TENANT, accountName: 'Acme' },
      { $set: { accountName: 'Initech' } },
    );

    for (const id of [first._id, second._id]) {
      expect((await stored(id)).searchKeys).toContain('initech');
      expect((await stored(id)).searchKeys).not.toContain('acme');
    }
    await expect(findable('initech')).resolves.toBe(2);
    // The phantom: before this, renaming an account left every deal findable
    // under a name it no longer had.
    await expect(findable('acme')).resolves.toBe(0);
  });

  it('should index tags added by an updateMany $addToSet', async () => {
    const doc = await model.create({ tenantId: TENANT, title: 'Delta' });

    await model.updateMany(
      { tenantId: TENANT, _id: doc._id },
      { $addToSet: { tags: { $each: ['enterprise', 'vip'] } } },
    );

    await expect(findable('enterprise')).resolves.toBe(1);
    await expect(findable('vip')).resolves.toBe(1);
    await expect(findable('delta')).resolves.toBe(1);
  });

  it('should keep the index current across findOneAndUpdate $addToSet and $pull', async () => {
    const doc = await model.create({
      tenantId: TENANT,
      title: 'Epsilon',
      tags: ['urgent'],
    });

    await model.findOneAndUpdate(
      { _id: doc._id },
      { $addToSet: { tags: 'renewal' } },
    );
    await expect(findable('renewal')).resolves.toBe(1);
    await expect(findable('urgent')).resolves.toBe(1);

    await model.findOneAndUpdate(
      { _id: doc._id },
      { $pull: { tags: 'urgent' } },
    );
    await expect(findable('renewal')).resolves.toBe(1);
    await expect(findable('urgent')).resolves.toBe(0);
  });

  it('should index the document an upsert creates', async () => {
    await model.updateOne(
      { tenantId: TENANT, title: 'Zeta' },
      { $set: { accountName: 'Umbrella' } },
      { upsert: true },
    );

    await expect(findable('zeta')).resolves.toBe(1);
    await expect(findable('umbrella')).resolves.toBe(1);
  });

  it('should keep masked values out of the searchable half', async () => {
    await model.create({
      tenantId: TENANT,
      title: 'Theta',
      emails: ['someone@example.com'],
    });

    // Field masking hides the address; search must not accept it as a lookup key
    // for a caller who cannot read it.
    await expect(findable('someone')).resolves.toBe(0);
    await expect(findable('someone', { includeSensitive: true })).resolves.toBe(
      1,
    );
  });

  it('should leave the arrays alone when no searchable field is touched', async () => {
    const doc = await model.create({ tenantId: TENANT, title: 'Iota' });
    const before = (await stored(doc._id)).searchKeys;

    await model.updateOne({ _id: doc._id }, { $set: { tenantId: TENANT } });

    expect((await stored(doc._id)).searchKeys).toEqual(before);
  });

  it('should refuse an update whose effect on the index cannot be derived', async () => {
    const doc = await model.create({ tenantId: TENANT, title: 'Kappa' });

    await expect(
      model.updateOne({ _id: doc._id }, { $rename: { title: 'headline' } }),
    ).rejects.toThrow(/cannot derive searchKeys/i);
  });
});
