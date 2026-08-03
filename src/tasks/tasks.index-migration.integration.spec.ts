import { MongoMemoryServer } from 'mongodb-memory-server';
import { Db, MongoClient } from 'mongodb';
import {
  migrateTaskIndexes,
  PLANNED_TASK_INDEXES,
} from '../scripts/migrations/2026-08-03-task-indexes';
import { TaskSchema } from './infrastructure/persistence/document/entities/task.schema';

/**
 * Runs the real migration against a real MongoDB.
 *
 * The migration is the only thing that creates task indexes in production
 * (`autoIndex` is false there), so "it looks right" is not enough — an index
 * migration that half-applies leaves the collection in a state nobody has
 * described. It imports the actual exported function rather than restating its
 * logic: a migration verified against a copy of itself is not verified.
 */
describe('task index migration (integration)', () => {
  let mongod: MongoMemoryServer;
  let client: MongoClient;
  let db: Db;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    client = await MongoClient.connect(mongod.getUri());
    db = client.db('task_index_migration');
  }, 60_000);

  afterAll(async () => {
    await client.close();
    await mongod.stop();
  });

  beforeEach(async () => {
    await db
      .collection('tasks')
      .drop()
      .catch(() => undefined);
    await db.collection('tasks').insertOne({ tenantId: 'a', title: 'seed' });
  });

  it('should create every planned index', async () => {
    const report = await migrateTaskIndexes(db);

    expect(report.created.sort()).toEqual(
      PLANNED_TASK_INDEXES.map((index) => index.name).sort(),
    );
    const names = (await db.collection('tasks').indexes()).map((i) => i.name);
    for (const planned of PLANNED_TASK_INDEXES) {
      expect(names).toContain(planned.name);
    }
  });

  it('should drop the index that keys a non-existent field', async () => {
    // `status` is not a task field — it is `statusId`. This index stored a null
    // entry per document: write cost, no read served.
    await db.collection('tasks').createIndex({ tenantId: 1, status: 1 });

    const report = await migrateTaskIndexes(db);

    expect(report.dropped).toContain('tenantId_1_status_1');
    const names = (await db.collection('tasks').indexes()).map((i) => i.name);
    expect(names).not.toContain('tenantId_1_status_1');
  });

  it('should drop the standalone orgUnitId index superseded by the compound one', async () => {
    await db.collection('tasks').createIndex({ orgUnitId: 1 });

    const report = await migrateTaskIndexes(db);

    expect(report.dropped).toContain('orgUnitId_1');
  });

  it('should be idempotent — a second run changes nothing', async () => {
    await migrateTaskIndexes(db);
    const second = await migrateTaskIndexes(db);

    expect(second.created).toEqual([]);
    expect(second.dropped).toEqual([]);
    expect(second.skipped).toHaveLength(PLANNED_TASK_INDEXES.length);
  });

  it('should rebuild an index whose definition changed', async () => {
    // Same name, different key. `createIndex` refuses a conflicting redefinition,
    // so the migration has to drop first or a changed index silently never applies.
    await db
      .collection('tasks')
      .createIndex({ tenantId: 1, dueDate: 1 }, { name: 'task_list_default' });

    const report = await migrateTaskIndexes(db);

    expect(report.dropped).toContain('task_list_default');
    expect(report.created).toContain('task_list_default');
    const rebuilt = (await db.collection('tasks').indexes()).find(
      (i) => i.name === 'task_list_default',
    );
    expect(Object.keys(rebuilt!.key)).toEqual([
      'tenantId',
      'deletedAt',
      'dueDate',
      '_id',
    ]);
  });

  it('should create exactly what the schema declares — no drift', async () => {
    // The third leg of the schema/migration/verifier triangle, checked against a
    // live server rather than by reading source text.
    await migrateTaskIndexes(db);

    const live = new Set(
      (await db.collection('tasks').indexes())
        .map((i) => i.name)
        .filter((name) => name !== '_id_'),
    );
    const declared = new Set(
      TaskSchema.indexes()
        .map(([, options]) => (options as { name?: string }).name)
        .filter((name): name is string => Boolean(name)),
    );

    expect([...live].sort()).toEqual([...declared].sort());
  });
});
