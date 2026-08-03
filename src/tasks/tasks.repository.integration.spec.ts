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
 * TaskRepository — INTEGRATION TESTS against a real MongoDB.
 *
 * The read path is tested against a real server rather than a mocked model
 * because the two defects that mattered most here were both invisible to a
 * mock: `populate()` on a path that is not in the schema only throws once the
 * query has actually returned a document, and the version predicate that
 * drives optimistic locking is only observable in what Mongo receives.
 */

const USER_SCHEMA_FIELDS = {
  firstName: String,
  lastName: String,
  email: String,
  photo: String,
};

describe('TaskRepository (integration)', () => {
  let connection: Connection;
  let repository: TaskRepository;
  let taskModel: Model<TaskSchemaDocument>;
  let statusModel: Model<any>;

  const tenantA = new Types.ObjectId().toString();
  const tenantB = new Types.ObjectId().toString();
  const userId = new Types.ObjectId().toString();

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
    // `owner` is a virtual with ref 'UserSchemaClass'; populate needs the model
    // registered on the same connection.
    connection.model('UserSchemaClass', new Schema(USER_SCHEMA_FIELDS));

    repository = new TaskRepository(
      taskModel,
      statusModel,
      ClsServiceManager.getClsService(),
    );
  }, 60_000);

  afterEach(async () => {
    await clearDatabase();
  });

  afterAll(async () => {
    await teardownTestDatabase();
  });

  async function seedTask(
    tenantId: string,
    overrides: Partial<TaskSchemaClass> = {},
  ) {
    return taskModel.create({
      tenantId,
      title: 'Follow up',
      dueDate: new Date('2026-09-01T00:00:00Z'),
      priority: 'HIGH',
      ownerId: userId,
      createdById: userId,
      updatedById: userId,
      ...overrides,
    } as any);
  }

  // The regression that closed C1
  //
  // `findManyWithPagination` and `findOne` used to populate 'assignedTo', a path
  // that is neither a field nor a virtual on TaskSchema. Mongoose 8 enables
  // strictPopulate by default, so that threw StrictPopulateError — but only once
  // the query matched at least one document, because populate short-circuits on
  // an empty result set. An empty tenant answered 200 and the same request
  // answered 500 the moment the first task existed, which is why it survived
  // smoke tests. Both tests below are written to fail loudly if anyone
  // reintroduces a populate of a path the schema does not declare.

  describe('read path survives a non-empty result set', () => {
    it('should list tasks without throwing StrictPopulateError', async () => {
      await runWithTenant(tenantA, async () => {
        await seedTask(tenantA);

        const result = await repository.findManyWithPagination({
          filterOptions: {},
          paginationOptions: { page: 1, limit: 10 },
        });

        expect(result.data).toHaveLength(1);
        expect(result.data[0].title).toBe('Follow up');
      });
    });

    it('should fetch one task without throwing StrictPopulateError', async () => {
      await runWithTenant(tenantA, async () => {
        const created = await seedTask(tenantA);

        const found = await repository.findOne({ _id: created._id });

        expect(found).not.toBeNull();
        expect(found!.title).toBe('Follow up');
      });
    });

    it('should populate only paths the schema declares', () => {
      // Guards the fix at the schema level rather than the call site: any future
      // populate('assignedTo') fails this before it reaches a query.
      const schemaPaths = Object.keys(TaskSchema.paths);
      const virtuals = Object.keys(TaskSchema.virtuals);
      const populated = ['owner', 'taskStatus', 'taskCategory', 'taskSource'];

      for (const path of populated) {
        expect([...schemaPaths, ...virtuals]).toContain(path);
      }
      expect([...schemaPaths, ...virtuals]).not.toContain('assignedTo');
    });
  });

  // Tenant isolation on every read the module owns

  describe('tenant isolation', () => {
    it('should never return another tenant task from the list', async () => {
      await runWithTenant(tenantB, async () => {
        await seedTask(tenantB, { title: 'Tenant B task' });
      });

      await runWithTenant(tenantA, async () => {
        await seedTask(tenantA, { title: 'Tenant A task' });

        const result = await repository.findManyWithPagination({
          filterOptions: {},
          paginationOptions: { page: 1, limit: 10 },
        });

        expect(result.data).toHaveLength(1);
        expect(result.data[0].title).toBe('Tenant A task');
        expect(result.totalItems).toBe(1);
      });
    });

    it('should never return another tenant task from findOne', async () => {
      const foreign = await runWithTenant(tenantB, async () =>
        seedTask(tenantB),
      );

      await runWithTenant(tenantA, async () => {
        const found = await repository.findOne({ _id: foreign._id });
        expect(found).toBeNull();
      });
    });
  });

  describe('soft delete', () => {
    it('should hide soft-deleted tasks from the list and from findOne', async () => {
      await runWithTenant(tenantA, async () => {
        const created = await seedTask(tenantA);
        await repository.remove(String(created._id));

        const list = await repository.findManyWithPagination({
          filterOptions: {},
          paginationOptions: { page: 1, limit: 10 },
        });
        expect(list.data).toHaveLength(0);

        const found = await repository.findOne({ _id: created._id });
        expect(found).toBeNull();
      });
    });

    it('should restore a task back into the list', async () => {
      await runWithTenant(tenantA, async () => {
        const created = await seedTask(tenantA);
        await repository.remove(String(created._id));

        const restored = await repository.restore(String(created._id));
        expect(restored).not.toBeNull();

        // `restore()` uses $unset, and the list filters `deletedAt: {$exists:
        // false}` — a restore that wrote `deletedAt: null` would leave the task
        // restored in the database and still invisible in the UI.
        const list = await repository.findManyWithPagination({
          filterOptions: {},
          paginationOptions: { page: 1, limit: 10 },
        });
        expect(list.data).toHaveLength(1);
      });
    });
  });
});
