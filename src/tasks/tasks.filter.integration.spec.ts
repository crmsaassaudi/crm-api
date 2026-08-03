import { Connection, Model, Schema, Types } from 'mongoose';
import { ClsServiceManager } from 'nestjs-cls';
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
 * List and export must select the SAME rows for the same filter.
 *
 * These two paths used to be built by two different functions that had drifted:
 * export read only `filters[]` and `search`, so a view narrowed by status,
 * priority, due-date range or contact exported the entire collection. That is
 * the failure mode worth a dedicated suite — it is silent, it ships a wrong file
 * to a customer, and no unit test on either function alone would catch it.
 */
describe('Task filters — list and export parity (integration)', () => {
  let connection: Connection;
  let repository: TaskRepository;
  let taskModel: Model<TaskSchemaDocument>;
  let statusModel: Model<any>;

  const tenantId = new Types.ObjectId().toString();
  const userId = new Types.ObjectId().toString();
  const contactId = new Types.ObjectId().toString();

  let openStatusId: string;
  let doneStatusId: string;

  beforeAll(async () => {
    connection = await setupTestDatabase();
    taskModel = connection.model(
      TaskSchemaClass.name,
      TaskSchema,
    ) as unknown as Model<TaskSchemaDocument>;
    statusModel = connection.model(
      TaskStatusSchemaClass.name,
      TaskStatusSchema,
    ) as unknown as Model<any>;
    connection.model('TaskCategorySchemaClass', TaskCategorySchema);
    connection.model('TaskSourceSchemaClass', TaskSourceSchema);
    connection.model(
      'UserSchemaClass',
      new Schema({
        firstName: String,
        lastName: String,
        email: String,
        photo: String,
      }),
    );
    repository = new TaskRepository(
      taskModel,
      statusModel,
      ClsServiceManager.getClsService(),
    );
  }, 60_000);

  afterAll(async () => {
    await teardownTestDatabase();
  });

  beforeEach(async () => {
    await clearDatabase();
    await runWithTenant(tenantId, async () => {
      const [open, done] = await statusModel.create([
        { tenantId, label: 'Open', apiName: 'open', isTerminal: false },
        { tenantId, label: 'Done', apiName: 'done', isTerminal: true },
      ]);
      openStatusId = String(open._id);
      doneStatusId = String(done._id);

      await taskModel.create([
        {
          tenantId,
          title: 'Overdue call for contact',
          dueDate: new Date('2026-01-10T00:00:00Z'),
          priority: 'URGENT',
          statusId: openStatusId,
          ownerId: userId,
          createdById: userId,
          updatedById: userId,
          relatedTo: { type: 'Contact', _id: contactId, name: 'Acme' },
        },
        {
          tenantId,
          title: 'Future low-priority task',
          dueDate: new Date('2026-12-01T00:00:00Z'),
          priority: 'LOW',
          statusId: openStatusId,
          ownerId: userId,
          createdById: userId,
          updatedById: userId,
        },
        {
          tenantId,
          title: 'Finished work',
          dueDate: new Date('2026-02-01T00:00:00Z'),
          priority: 'URGENT',
          statusId: doneStatusId,
          ownerId: userId,
          createdById: userId,
          updatedById: userId,
        },
      ] as any);
    });
  });

  /** Titles the export cursor yields for a filter. */
  async function exportTitles(filters: Record<string, unknown>) {
    const cursor = repository.streamForExport({ filters });
    const titles: string[] = [];
    for await (const doc of cursor) titles.push(doc.title);
    return titles.sort();
  }

  /** Titles the list endpoint yields for the same filter. */
  async function listTitles(filters: Record<string, unknown>) {
    const result = await repository.findManyWithPagination({
      filterOptions: filters as any,
      paginationOptions: { page: 1, limit: 100 },
    });
    return result.data.map((task) => task.title).sort();
  }

  const CASES: Array<[string, Record<string, unknown>, string[]]> = [
    [
      'priority',
      { priorities: ['URGENT'] },
      ['Finished work', 'Overdue call for contact'],
    ],
    [
      'due-date range',
      { dueTo: '2026-01-31T00:00:00Z' },
      ['Overdue call for contact'],
    ],
    ['free-text search', { search: 'Finished' }, ['Finished work']],
    [
      'no filter',
      {},
      ['Finished work', 'Future low-priority task', 'Overdue call for contact'],
    ],
  ];

  describe.each(CASES)('filter: %s', (_name, filters, expected) => {
    it('should return the expected rows from the list', async () => {
      await runWithTenant(tenantId, async () => {
        expect(await listTitles(filters)).toEqual(expected);
      });
    });

    it('should return exactly the same rows from the export as from the list', async () => {
      await runWithTenant(tenantId, async () => {
        const [fromList, fromExport] = [
          await listTitles(filters),
          await exportTitles(filters),
        ];
        expect(fromExport).toEqual(fromList);
      });
    });
  });

  it('should apply statusIds to both list and export', async () => {
    await runWithTenant(tenantId, async () => {
      const filters = { statusIds: [doneStatusId] };
      expect(await listTitles(filters)).toEqual(['Finished work']);
      expect(await exportTitles(filters)).toEqual(['Finished work']);
    });
  });

  it('should apply contactId to both list and export', async () => {
    await runWithTenant(tenantId, async () => {
      const filters = { contactId };
      expect(await listTitles(filters)).toEqual(['Overdue call for contact']);
      expect(await exportTitles(filters)).toEqual(['Overdue call for contact']);
    });
  });

  describe('status resolved from apiName', () => {
    it('should resolve a name to its id', async () => {
      await runWithTenant(tenantId, async () => {
        expect(await listTitles({ status: 'done' })).toEqual(['Finished work']);
      });
    });

    it('should narrow to nothing — never widens — when the name matches no status', async () => {
      await runWithTenant(tenantId, async () => {
        // The dangerous alternative is dropping the predicate, which turns a
        // typo in a saved view into "show me everything".
        expect(await listTitles({ status: 'no-such-status' })).toEqual([]);
      });
    });
  });

  describe('pagination limits', () => {
    it('should never serves more than the module cap even when asked for more', async () => {
      await runWithTenant(tenantId, async () => {
        const result = await repository.findManyWithPagination({
          filterOptions: {},
          paginationOptions: { page: 1, limit: 2 },
        });
        expect(result.data).toHaveLength(2);
        expect(result.totalItems).toBe(3);
      });
    });

    it('should sort with a unique tie-breaker so pages cannot overlap', async () => {
      await runWithTenant(tenantId, async () => {
        // Three tasks sharing one dueDate: without `_id` in the sort spec the
        // order between them is undefined, and a row can appear on both page 1
        // and page 2 while another appears on neither.
        const sameDue = new Date('2026-06-01T00:00:00Z');
        // Scoped to the tenant, not `{}` — the repo lints bare deleteMany for a
        // reason, and a test that ignores the rule teaches the wrong habit.
        await taskModel.deleteMany({ tenantId });
        await taskModel.create(
          ['a', 'b', 'c', 'd'].map((title) => ({
            tenantId,
            title,
            dueDate: sameDue,
            priority: 'MEDIUM',
            ownerId: userId,
            createdById: userId,
            updatedById: userId,
          })) as any,
        );

        const page1 = await repository.findManyWithPagination({
          filterOptions: {},
          paginationOptions: { page: 1, limit: 2 },
        });
        const page2 = await repository.findManyWithPagination({
          filterOptions: {},
          paginationOptions: { page: 2, limit: 2 },
        });

        const ids = [...page1.data, ...page2.data].map((task) => task.id);
        expect(new Set(ids).size).toBe(4);
      });
    });
  });
});
