import { Connection, Model, Schema, Types } from 'mongoose';
import { ClsService, ClsServiceManager } from 'nestjs-cls';
import {
  setupTestDatabase,
  clearDatabase,
  teardownTestDatabase,
} from '../test/integration-setup';
import { runWithTenant } from '../test/helpers/cls-context.helper';
import {
  TaskSchema,
  TaskSchemaClass,
  TaskSchemaDocument,
} from './infrastructure/persistence/document/entities/task.schema';
import {
  TaskStatusSchema,
  TaskStatusSchemaClass,
} from '../task-settings/entities/task-status.schema';
import { TaskCategorySchema } from '../task-settings/entities/task-category.schema';
import { TaskSourceSchema } from '../task-settings/entities/task-source.schema';
import { TaskRepository } from './infrastructure/persistence/document/repositories/task.repository';

/**
 * Export must not read wider than the request that asked for it.
 *
 * The defect this guards was a privilege escalation with an ordinary permission
 * in front of it. A BullMQ worker has no HTTP request, so
 * `DataVisibilityInterceptor` never runs for it, and the CLS store it inherited
 * carried only `tenantId`. `applyTenantFilter` reads an absent `visibleOwnerIds`
 * as "no owner predicate" — a sane default for an admin, fail-OPEN for a worker —
 * so the export cursor returned every row in the tenant. A user with a SELF data
 * scope whose list showed three tasks could press Export and receive all of them.
 *
 * The suite works at the CLS level on purpose: that is the exact layer where the
 * request and the worker diverged, and it is where a future refactor would break
 * this again.
 */
describe('Task export honours the requester scope (integration)', () => {
  let connection: Connection;
  let repository: TaskRepository;
  let taskModel: Model<TaskSchemaDocument>;
  let cls: ClsService;

  const tenantId = new Types.ObjectId().toString();
  const alice = new Types.ObjectId().toString();
  const bob = new Types.ObjectId().toString();

  beforeAll(async () => {
    connection = await setupTestDatabase();
    taskModel = connection.model(
      TaskSchemaClass.name,
      TaskSchema,
    ) as unknown as Model<TaskSchemaDocument>;
    const statusModel = connection.model(
      TaskStatusSchemaClass.name,
      TaskStatusSchema,
    ) as unknown as Model<any>;
    connection.model('TaskCategorySchemaClass', TaskCategorySchema);
    connection.model('TaskSourceSchemaClass', TaskSourceSchema);
    connection.model('UserSchemaClass', new Schema({ firstName: String }));

    cls = ClsServiceManager.getClsService();
    repository = new TaskRepository(taskModel, statusModel, cls);
  }, 60_000);

  afterAll(async () => {
    await teardownTestDatabase();
  });

  beforeEach(async () => {
    await clearDatabase();
    // Seeding runs inside a tenant context because `tenantFilterPlugin` fails
    // closed on writes with no `activeTenantId` — the behaviour these tests rely
    // on everywhere else.
    await runWithTenant(tenantId, async () => {
      await taskModel.create([
        {
          tenantId,
          title: 'alice task',
          dueDate: new Date('2026-09-01T00:00:00Z'),
          priority: 'HIGH',
          ownerId: alice,
          createdById: alice,
          updatedById: alice,
        },
        {
          tenantId,
          title: 'bob task 1',
          dueDate: new Date('2026-09-02T00:00:00Z'),
          priority: 'HIGH',
          ownerId: bob,
          createdById: bob,
          updatedById: bob,
        },
        {
          tenantId,
          title: 'bob task 2',
          dueDate: new Date('2026-09-03T00:00:00Z'),
          priority: 'HIGH',
          ownerId: bob,
          createdById: bob,
          updatedById: bob,
        },
      ] as any);
    });
  });

  /**
   * Run inside a CLS store shaped like the one a worker builds from job data.
   * `store` is spread in wholesale, exactly as BaseTenantConsumer does it.
   */
  function runAsWorker<T>(
    store: Record<string, unknown>,
    fn: () => Promise<T>,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      void cls.run(async () => {
        cls.set('tenantId', tenantId);
        cls.set('activeTenantId', tenantId);
        for (const [key, value] of Object.entries(store)) {
          cls.set(key, value);
        }
        try {
          resolve(await fn());
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  async function exportedTitles(): Promise<string[]> {
    const cursor = repository.streamForExport({ filters: {} });
    const titles: string[] = [];
    for await (const doc of cursor) titles.push(doc.title);
    return titles.sort();
  }

  it('should export only the rows a SELF-scoped requester can see', async () => {
    const titles = await runAsWorker(
      { visibleOwnerIds: [alice] },
      exportedTitles,
    );
    expect(titles).toEqual(['alice task']);
  });

  it('should count only the rows a SELF-scoped requester can see', async () => {
    const count = await runAsWorker({ visibleOwnerIds: [alice] }, () =>
      repository.countForExport({ filters: {} }),
    );
    expect(count).toBe(1);
  });

  it('should export the whole tenant for an admin (visibleOwnerIds === null)', async () => {
    // null is the admin bypass and must stay distinguishable from undefined —
    // which is why the snapshot serialises null rather than dropping the key.
    const titles = await runAsWorker({ visibleOwnerIds: null }, exportedTitles);
    expect(titles).toEqual(['alice task', 'bob task 1', 'bob task 2']);
  });

  it('should export NOTHING for a requester whose scope resolves to an empty set', async () => {
    // `[]` means "sees no rows". Collapsing it to undefined — the shape the
    // worker used to inherit — turns it into "sees everything".
    const titles = await runAsWorker({ visibleOwnerIds: [] }, exportedTitles);
    expect(titles).toEqual([]);
  });

  it('should apply the ABAC deny filter carried in the snapshot', async () => {
    const titles = await runAsWorker(
      {
        visibleOwnerIds: null,
        abacResourceFilter: {
          resource: 'tasks',
          filter: { title: { $ne: 'bob task 2' } },
        },
      },
      exportedTitles,
    );
    expect(titles).toEqual(['alice task', 'bob task 1']);
  });

  it('should respect a per-module visibility override', async () => {
    const titles = await runAsWorker(
      {
        // Request-wide scope says "everything"; the Task-specific entry narrows.
        visibleOwnerIds: null,
        dataVisibilityByModule: {
          Task: { ownerIds: [bob], orgUnitIds: null },
        },
      },
      exportedTitles,
    );
    expect(titles).toEqual(['bob task 1', 'bob task 2']);
  });

  describe('the bug this replaced', () => {
    it('should read the whole tenant from a worker CLS carrying only the tenant', async () => {
      // Pinned deliberately. This documents that the repository layer alone
      // cannot save us: with no scope in CLS it is *correct* for it to return
      // everything, so the guarantee has to come from the snapshot being present.
      // If someone removes `scope` from the job payload, this test still passes
      // and the four above start failing — which is the signal to look here.
      const titles = await runAsWorker({}, exportedTitles);
      expect(titles).toEqual(['alice task', 'bob task 1', 'bob task 2']);
    });
  });
});
