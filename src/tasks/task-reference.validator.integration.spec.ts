import { Connection, Model, Schema, Types } from 'mongoose';
import { UnprocessableEntityException } from '@nestjs/common';
import {
  setupTestDatabase,
  clearDatabase,
  teardownTestDatabase,
} from '../test/integration-setup';
import { runWithTenant } from '../test/helpers/cls-context.helper';
import {
  TaskStatusSchema,
  TaskStatusSchemaClass,
} from '../task-settings/entities/task-status.schema';
import {
  TaskCategorySchema,
  TaskCategorySchemaClass,
} from '../task-settings/entities/task-category.schema';
import {
  TaskSourceSchema,
  TaskSourceSchemaClass,
} from '../task-settings/entities/task-source.schema';
import { TaskReferenceValidator } from './task-reference.validator';
import { tenantFilterPlugin } from '../common/plugins/tenant-filter.plugin';

/**
 * References must exist inside the CALLER'S tenant.
 *
 * Run against a real database because the guarantee is produced by
 * `tenantFilterPlugin` rewriting each lookup, not by anything visible in the
 * validator's own code — a mocked model would happily return a foreign document
 * and the test would prove nothing.
 *
 * The consequence of not having this: `ownerId` accepted any ObjectId. Data
 * visibility filters on `ownerId: {$in: visibleOwnerIds}`, so a task pointed at an
 * id outside the tenant matched nobody's scope and only an admin could see it —
 * one PATCH to hide your own work from every level of management.
 */

// A minimal stand-in for the user collection, scoped the way the real one is
// (`tenants.tenantId`, not a flat `tenantId`).
const UserStub = new Schema({
  firstName: String,
  status: String,
  deletedAt: { type: Date, default: null },
  tenants: [{ tenantId: Schema.Types.ObjectId }],
});
UserStub.plugin(tenantFilterPlugin, { field: 'tenants.tenantId' });

/**
 * Pull the field→message map out of a 422.
 *
 * `UnprocessableEntityException` built with an object payload keeps that payload in
 * `getResponse()`, and its `.message` is the generic "Unprocessable Entity
 * Exception" — so asserting on the message proves nothing. Reading the payload also
 * pins the FIELD KEY, which is what a client uses to attach the error to an input.
 */
async function expect422(
  run: () => Promise<unknown>,
): Promise<Record<string, string>> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(UnprocessableEntityException);
    const response = (error as UnprocessableEntityException).getResponse() as {
      errors: Record<string, string>;
    };
    return response.errors;
  }
  throw new Error('Expected the call to be refused with 422, but it resolved.');
}

describe('TaskReferenceValidator (integration)', () => {
  let connection: Connection;
  let validator: TaskReferenceValidator;
  let statusModel: Model<any>;
  let categoryModel: Model<any>;
  let sourceModel: Model<any>;
  let userModel: Model<any>;

  const tenantA = new Types.ObjectId().toString();
  const tenantB = new Types.ObjectId().toString();

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
    userModel = connection.model('UserSchemaClass', UserStub) as Model<any>;

    validator = new TaskReferenceValidator(
      statusModel,
      categoryModel,
      sourceModel,
      userModel,
    );
  }, 60_000);

  afterAll(async () => {
    await teardownTestDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
  });

  async function seedUser(
    tenantId: string,
    overrides: Record<string, unknown> = {},
  ) {
    return runWithTenant(tenantId, async () =>
      userModel.create({
        firstName: 'U',
        status: 'active',
        tenants: [{ tenantId }],
        ...overrides,
      }),
    );
  }

  describe('ownerId', () => {
    it('should accept an active user of the same tenant', async () => {
      const user = await seedUser(tenantA);
      await runWithTenant(tenantA, async () => {
        await expect(
          validator.resolve({ ownerId: String(user._id) }),
        ).resolves.toBeDefined();
      });
    });

    it('should refuse a user from another tenant', async () => {
      const foreign = await seedUser(tenantB);
      await runWithTenant(tenantA, async () => {
        const errors = await expect422(() =>
          validator.resolve({ ownerId: String(foreign._id) }),
        );
        expect(errors.ownerId).toMatch(/không tồn tại/);
      });
    });

    it('should refuse an id that matches no user at all', async () => {
      await runWithTenant(tenantA, async () => {
        const errors = await expect422(() =>
          validator.resolve({ ownerId: new Types.ObjectId().toString() }),
        );
        expect(errors.ownerId).toMatch(/không tồn tại/);
      });
    });

    it('should refuse a soft-deleted user', async () => {
      const deleted = await seedUser(tenantA, { deletedAt: new Date() });
      await runWithTenant(tenantA, async () => {
        const errors = await expect422(() =>
          validator.resolve({ ownerId: String(deleted._id) }),
        );
        expect(errors.ownerId).toMatch(/không tồn tại/);
      });
    });

    it('should refuse a deactivated user', async () => {
      // Assigning work to a deactivated account is indistinguishable from losing
      // it — nobody will ever open that queue.
      const inactive = await seedUser(tenantA, { status: 'inactive' });
      await runWithTenant(tenantA, async () => {
        const errors = await expect422(() =>
          validator.resolve({ ownerId: String(inactive._id) }),
        );
        expect(errors.ownerId).toMatch(/vô hiệu hoá/);
      });
    });

    it('should answer 422, not 500, for a malformed id', async () => {
      // Left to Mongoose this surfaced as a CastError — a 500 for a plain bad
      // request.
      await runWithTenant(tenantA, async () => {
        const errors = await expect422(() =>
          validator.resolve({ ownerId: 'not-an-objectid' }),
        );
        expect(errors.ownerId).toMatch(/ObjectId/);
      });
    });

    it('should accept an absent owner', async () => {
      await runWithTenant(tenantA, async () => {
        await expect(validator.resolve({})).resolves.toBeDefined();
      });
    });
  });

  describe('settings references', () => {
    it('should refuse a status from another tenant', async () => {
      const foreign = await runWithTenant(tenantB, async () =>
        statusModel.create({
          tenantId: tenantB,
          label: 'Done',
          apiName: 'done',
          isTerminal: true,
        }),
      );
      await runWithTenant(tenantA, async () => {
        const errors = await expect422(() =>
          validator.resolve({ statusId: String(foreign._id) }),
        );
        expect(errors.statusId).toMatch(/Trạng thái không tồn tại/);
      });
    });

    it('should refuse a category that does not exist', async () => {
      await runWithTenant(tenantA, async () => {
        const errors = await expect422(() =>
          validator.resolve({ categoryId: new Types.ObjectId().toString() }),
        );
        expect(errors.categoryId).toMatch(/Nhóm công việc/);
      });
    });

    it('should refuse a source that does not exist', async () => {
      await runWithTenant(tenantA, async () => {
        const errors = await expect422(() =>
          validator.resolve({ sourceId: new Types.ObjectId().toString() }),
        );
        expect(errors.sourceId).toMatch(/Nguồn công việc/);
      });
    });
  });

  describe('status facts returned for the lifecycle rules', () => {
    it('should report terminality for this tenant only', async () => {
      const [open, done] = await runWithTenant(tenantA, async () =>
        statusModel.create([
          {
            tenantId: tenantA,
            label: 'Open',
            apiName: 'open',
            isTerminal: false,
          },
          {
            tenantId: tenantA,
            label: 'Done',
            apiName: 'done',
            isTerminal: true,
          },
        ]),
      );
      const foreign = await runWithTenant(tenantB, async () =>
        statusModel.create({
          tenantId: tenantB,
          label: 'X',
          apiName: 'x',
          isTerminal: true,
        }),
      );

      await runWithTenant(tenantA, async () => {
        const { statuses } = await validator.resolve({});
        expect(statuses.get(String(open._id))).toEqual({ isTerminal: false });
        expect(statuses.get(String(done._id))).toEqual({ isTerminal: true });
        // A foreign status must be absent, not merely non-terminal: the lifecycle
        // rules refuse an unknown status, which is the fail-closed direction.
        expect(statuses.has(String(foreign._id))).toBe(false);
      });
    });
  });
});
