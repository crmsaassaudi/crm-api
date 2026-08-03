import { Connection, Model, Schema, Types } from 'mongoose';
import { ConflictException } from '@nestjs/common';
import {
  setupTestDatabase,
  clearDatabase,
  teardownTestDatabase,
} from '../test/integration-setup';
import { runWithTenant } from '../test/helpers/cls-context.helper';
import { ClsServiceManager } from 'nestjs-cls';
import {
  TaskStatusSchema,
  TaskStatusSchemaClass,
} from './entities/task-status.schema';
import {
  TaskCategorySchema,
  TaskCategorySchemaClass,
} from './entities/task-category.schema';
import {
  TaskSourceSchema,
  TaskSourceSchemaClass,
} from './entities/task-source.schema';
import {
  TaskSchema,
  TaskSchemaClass,
} from '../tasks/infrastructure/persistence/document/entities/task.schema';
import { TaskSettingsService } from './task-settings.service';

/**
 * Deleting a task setting must not orphan the tasks that use it.
 *
 * These were unconditional hard deletes with no referential check. Removing a
 * status in use left every task pointing at a document that no longer existed:
 * `populate('taskStatus')` returned null, so the Kanban board lost a column and
 * those tasks rendered with no status, and `?status=` — which resolves apiNames to
 * ids — matched nothing and returned an empty list. All silent, and unrecoverable,
 * because settings have no recycle bin.
 */
describe('TaskSettingsService deletion guards (integration)', () => {
  let connection: Connection;
  let service: TaskSettingsService;
  let statusModel: Model<any>;
  let categoryModel: Model<any>;
  let sourceModel: Model<any>;
  let taskModel: Model<any>;

  const tenantId = new Types.ObjectId().toString();
  const otherTenant = new Types.ObjectId().toString();
  const userId = new Types.ObjectId().toString();

  beforeAll(async () => {
    connection = await setupTestDatabase();
    statusModel = connection.model(
      TaskStatusSchemaClass.name,
      TaskStatusSchema,
    ) as unknown as Model<any>;
    categoryModel = connection.model(
      TaskCategorySchemaClass.name,
      TaskCategorySchema,
    ) as unknown as Model<any>;
    sourceModel = connection.model(
      TaskSourceSchemaClass.name,
      TaskSourceSchema,
    ) as unknown as Model<any>;
    taskModel = connection.model(
      TaskSchemaClass.name,
      TaskSchema,
    ) as unknown as Model<any>;
    connection.model('UserSchemaClass', new Schema({ firstName: String }));

    service = new TaskSettingsService(
      statusModel,
      categoryModel,
      sourceModel,
      taskModel,
      ClsServiceManager.getClsService(),
    );
  }, 60_000);

  afterAll(async () => {
    await teardownTestDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  async function seedStatus(tid = tenantId) {
    return runWithTenant(tid, async () =>
      statusModel.create({
        tenantId: tid,
        label: 'Open',
        apiName: `open-${Math.random().toString(36).slice(2, 8)}`,
        isTerminal: false,
      }),
    );
  }

  async function seedTask(
    tid: string,
    overrides: Record<string, unknown> = {},
  ) {
    return runWithTenant(tid, async () =>
      taskModel.create({
        tenantId: tid,
        title: 'T',
        dueDate: new Date(),
        priority: 'MEDIUM',
        createdById: userId,
        updatedById: userId,
        ...overrides,
      }),
    );
  }

  describe('statuses', () => {
    it('should refuse to delete a status that tasks reference', async () => {
      const status = await seedStatus();
      await seedTask(tenantId, { statusId: status._id });

      await runWithTenant(tenantId, async () => {
        await expect(service.deleteStatus(String(status._id))).rejects.toThrow(
          ConflictException,
        );
      });

      // Still there — a refused delete must not partially apply.
      const survived = await statusModel
        .findById(status._id)
        .setOptions({ isPlatformQuery: true } as any)
        .lean();
      expect(survived).not.toBeNull();
    });

    it('should name the number of tasks blocking the delete', async () => {
      const status = await seedStatus();
      await seedTask(tenantId, { statusId: status._id });
      await seedTask(tenantId, { statusId: status._id });

      await runWithTenant(tenantId, async () => {
        await expect(service.deleteStatus(String(status._id))).rejects.toThrow(
          /2 task/,
        );
      });
    });

    it('should delete a status nothing references', async () => {
      const status = await seedStatus();

      await runWithTenant(tenantId, async () => {
        await expect(
          service.deleteStatus(String(status._id)),
        ).resolves.toBeUndefined();
      });

      const gone = await statusModel
        .findById(status._id)
        .setOptions({ isPlatformQuery: true } as any)
        .lean();
      expect(gone).toBeNull();
    });

    it('should count soft-deleted tasks as references', async () => {
      // They are restorable, and restoring a task whose status had been deleted in
      // the meantime would reintroduce exactly the dangling reference this guard
      // exists to prevent.
      const status = await seedStatus();
      await seedTask(tenantId, {
        statusId: status._id,
        deletedAt: new Date(),
      });

      await runWithTenant(tenantId, async () => {
        await expect(service.deleteStatus(String(status._id))).rejects.toThrow(
          ConflictException,
        );
      });
    });

    it('should not count another tenant tasks as references', async () => {
      // Otherwise one tenant's data could block another tenant's configuration
      // change — a cross-tenant coupling through the reference count.
      const status = await seedStatus();
      const foreignStatus = await seedStatus(otherTenant);
      await seedTask(otherTenant, { statusId: foreignStatus._id });

      await runWithTenant(tenantId, async () => {
        await expect(
          service.deleteStatus(String(status._id)),
        ).resolves.toBeUndefined();
      });
    });
  });

  describe('categories and sources', () => {
    it('should refuse to delete a category in use', async () => {
      const category = await runWithTenant(tenantId, async () =>
        categoryModel.create({
          tenantId,
          name: 'Call',
          apiName: 'call',
        }),
      );
      await seedTask(tenantId, { categoryId: category._id });

      await runWithTenant(tenantId, async () => {
        await expect(
          service.deleteCategory(String(category._id)),
        ).rejects.toThrow(/Nhóm công việc/);
      });
    });

    it('should refuse to delete a source in use', async () => {
      const source = await runWithTenant(tenantId, async () =>
        sourceModel.create({ tenantId, name: 'Manual', apiName: 'manual' }),
      );
      await seedTask(tenantId, { sourceId: source._id });

      await runWithTenant(tenantId, async () => {
        await expect(service.deleteSource(String(source._id))).rejects.toThrow(
          /Nguồn công việc/,
        );
      });
    });
  });
});
