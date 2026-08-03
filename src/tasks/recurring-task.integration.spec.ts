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
import { RecurringTaskService } from './recurring-task.service';

/**
 * The recurrence scheduler, against a real database.
 *
 * Two properties matter and neither can be shown with a mock:
 *
 *  1. **No duplicates.** `@Cron` fires in every process that loaded
 *     ScheduleModule, so the claim on `nextOccurrenceAt` has to be a genuine
 *     compare-and-set — which is a database guarantee, not a code-shape one.
 *  2. **No losses.** The claim advances the cursor BEFORE the occurrence is
 *     created, so a failed insert used to skip that occurrence permanently: the
 *     cursor had moved and nothing retried. A missing weekly follow-up is not
 *     something anyone notices, which is what makes it worth a test.
 */
describe('RecurringTaskService (integration)', () => {
  let connection: Connection;
  let service: RecurringTaskService;
  let taskModel: Model<TaskSchemaDocument>;

  const tenantId = new Types.ObjectId().toString();
  const owner = new Types.ObjectId().toString();
  const orgUnitId = new Types.ObjectId().toString();

  beforeAll(async () => {
    connection = await setupTestDatabase();
    taskModel = connection.model(
      TaskSchemaClass.name,
      TaskSchema,
    ) as unknown as Model<TaskSchemaDocument>;
    connection.model('UserSchemaClass', new Schema({ firstName: String }));
    service = new RecurringTaskService(
      taskModel,
      ClsServiceManager.getClsService(),
    );
  }, 60_000);

  afterAll(async () => {
    await teardownTestDatabase();
  });

  afterEach(async () => {
    await clearDatabase();
    jest.restoreAllMocks();
  });

  async function seedTemplate(overrides: Record<string, unknown> = {}) {
    return runWithTenant(tenantId, async () =>
      taskModel.create({
        tenantId,
        title: 'Weekly sync',
        dueDate: new Date('2026-08-01T09:00:00Z'),
        priority: 'MEDIUM',
        ownerId: owner,
        orgUnitId,
        createdById: owner,
        updatedById: owner,
        isRecurring: true,
        recurrenceRule: 'weekly',
        recurrenceInterval: 1,
        nextOccurrenceAt: new Date('2026-08-01T09:00:00Z'),
        ...overrides,
      } as any),
    );
  }

  // Selected by `parentTaskId`, not by `isRecurring: false` — when a recurrence
  // ends the TEMPLATE also becomes `isRecurring: false`, so that predicate counts
  // the template as one of its own children.
  const children = () =>
    taskModel
      .find({ parentTaskId: { $ne: null } })
      .setOptions({ isPlatformQuery: true } as any)
      .lean();

  it('should spawn one occurrence and advances the cursor', async () => {
    const template = await seedTemplate();

    await service.spawnDueOccurrences();

    const spawned = await children();
    expect(spawned).toHaveLength(1);
    expect(spawned[0].title).toBe('Weekly sync');
    expect(String(spawned[0].parentTaskId)).toBe(String(template._id));
    // The occurrence is due ON its occurrence date. The previous offset arithmetic
    // shifted it by `template.dueDate - template.createdAt`, which both
    // double-counted the seeded cursor and could land in the past.
    expect(spawned[0].dueDate).toEqual(new Date('2026-08-01T09:00:00Z'));

    const reloaded = await taskModel
      .findById(template._id)
      .setOptions({ isPlatformQuery: true } as any)
      .lean();
    expect(reloaded!.nextOccurrenceAt).toEqual(
      new Date('2026-08-08T09:00:00Z'),
    );
  });

  it('should copy orgUnitId to the occurrence', async () => {
    // Without this the child had no org unit and was invisible to every user whose
    // data scope is org-unit based — the work existed and the team responsible for
    // it could not see it.
    await seedTemplate();
    await service.spawnDueOccurrences();
    const [spawned] = await children();
    expect(String(spawned.orgUnitId)).toBe(orgUnitId);
  });

  it('should spawn nothing extra when two sweeps race', async () => {
    await seedTemplate();

    // Both sweeps read the same due template; only one claim can win.
    await Promise.all([
      service.spawnDueOccurrences(),
      service.spawnDueOccurrences(),
    ]);

    expect(await children()).toHaveLength(1);
  });

  it('should not run a second time for an already-claimed occurrence', async () => {
    await seedTemplate();
    await service.spawnDueOccurrences();
    await service.spawnDueOccurrences();

    // The cursor has moved past `now`, so the second sweep finds nothing due.
    expect(await children()).toHaveLength(1);
  });

  describe('a template with no ownerId', () => {
    it('should attribute the occurrence to the template creator instead of failing', async () => {
      // The fallback used to be the string 'system', which is not a valid ObjectId
      // for a required ref — so every ownerless template threw a CastError AFTER
      // the claim had advanced, spawning nothing forever while logging one error an
      // hour.
      const creator = new Types.ObjectId().toString();
      await seedTemplate({ ownerId: undefined, createdById: creator });

      await service.spawnDueOccurrences();

      const spawned = await children();
      expect(spawned).toHaveLength(1);
      expect(String(spawned[0].createdById)).toBe(creator);
    });
  });

  describe('when creating the occurrence fails', () => {
    it('should release the claim so the occurrence is not lost', async () => {
      const template = await seedTemplate();
      const originalCursor = new Date('2026-08-01T09:00:00Z');

      jest
        .spyOn(taskModel, 'create')
        .mockRejectedValueOnce(new Error('transient write failure'));

      await service.spawnDueOccurrences();

      expect(await children()).toHaveLength(0);

      // The cursor is back where it was, so the next sweep retries this occurrence
      // rather than skipping it.
      const reloaded = await taskModel
        .findById(template._id)
        .setOptions({ isPlatformQuery: true } as any)
        .lean();
      expect(reloaded!.nextOccurrenceAt).toEqual(originalCursor);
    });

    it('should the next sweep then succeeds', async () => {
      await seedTemplate();
      jest
        .spyOn(taskModel, 'create')
        .mockRejectedValueOnce(new Error('transient write failure'));

      await service.spawnDueOccurrences();
      jest.restoreAllMocks();
      await service.spawnDueOccurrences();

      expect(await children()).toHaveLength(1);
    });
  });

  describe('end of recurrence', () => {
    it('should stop the template once the next date passes recurrenceEndsAt', async () => {
      const template = await seedTemplate({
        recurrenceEndsAt: new Date('2026-08-05T00:00:00Z'),
      });

      await service.spawnDueOccurrences();

      const reloaded = await taskModel
        .findById(template._id)
        .setOptions({ isPlatformQuery: true } as any)
        .lean();
      expect(reloaded!.isRecurring).toBe(false);
      // The final occurrence is still created — ending recurrence must not swallow
      // the instance that was already due.
      expect(await children()).toHaveLength(1);
    });
  });

  it('should ignore soft-deleted templates', async () => {
    await seedTemplate({ deletedAt: new Date() });
    await service.spawnDueOccurrences();
    expect(await children()).toHaveLength(0);
  });

  it('should ignore templates whose next occurrence is in the future', async () => {
    await seedTemplate({ nextOccurrenceAt: new Date('2099-01-01T00:00:00Z') });
    await service.spawnDueOccurrences();
    expect(await children()).toHaveLength(0);
  });
});
