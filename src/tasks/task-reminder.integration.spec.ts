import { Connection, Model, Schema, Types } from 'mongoose';
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
import { TaskReminderService } from './task-reminder.service';
import { TASK_REMINDER_CHANNEL } from './tasks.constants';

/**
 * The reminder dispatcher, against a real database.
 *
 * `reminderAt` had been collected by the UI and persisted since the field existed,
 * and read by nothing — no cron, no queue, no listener. The product asked for a
 * time, said it was saved, and never sent anything. These tests assert the two
 * properties that make a reminder trustworthy: it is delivered, and it is delivered
 * once even though `@Cron` fires in every replica.
 */
describe('TaskReminderService (integration)', () => {
  let connection: Connection;
  let taskModel: Model<TaskSchemaDocument>;
  let redis: { publish: jest.Mock };
  let service: TaskReminderService;

  const tenantId = new Types.ObjectId().toString();
  const owner = new Types.ObjectId().toString();

  beforeAll(async () => {
    connection = await setupTestDatabase();
    taskModel = connection.model(
      TaskSchemaClass.name,
      TaskSchema,
    ) as unknown as Model<TaskSchemaDocument>;
    connection.model('UserSchemaClass', new Schema({ firstName: String }));
  }, 60_000);

  afterAll(async () => {
    await teardownTestDatabase();
  });

  beforeEach(async () => {
    await clearDatabase();
    redis = { publish: jest.fn().mockResolvedValue(1) };
    service = new TaskReminderService(taskModel, redis as any);
  });

  async function seedTask(overrides: Record<string, unknown> = {}) {
    return runWithTenant(tenantId, async () =>
      taskModel.create({
        tenantId,
        title: 'Call the client',
        dueDate: new Date('2026-08-04T09:00:00Z'),
        priority: 'HIGH',
        ownerId: owner,
        createdById: owner,
        updatedById: owner,
        reminderAt: new Date(Date.now() - 60_000),
        ...overrides,
      } as any),
    );
  }

  it('should publish a due reminder on the bridged channel', async () => {
    await seedTask();

    const result = await service.dispatchDueReminders();

    expect(result).toEqual({ sent: 1, skipped: 0 });
    expect(redis.publish).toHaveBeenCalledTimes(1);
    const [channel, payload] = redis.publish.mock.calls[0];
    // The channel name has to be one CrmRealtimeGateway subscribes to; anything
    // else is published into the void.
    expect(channel).toBe(TASK_REMINDER_CHANNEL);
    expect(JSON.parse(payload)).toMatchObject({
      tenantId,
      ownerId: owner,
      title: 'Call the client',
    });
  });

  it('should publish on exactly one channel, and one that is subscribed', async () => {
    await seedTask();
    await service.dispatchDueReminders();

    // The service used to also emit an `internal.notification` event for a
    // consumer that was never written. An emit nobody listens to is not a
    // delivery path, so the Redis publish is the only one left.
    expect(redis.publish).toHaveBeenCalledTimes(1);
    expect(redis.publish.mock.calls[0][0]).toBe(TASK_REMINDER_CHANNEL);
  });

  it('should mark the task so the reminder cannot be sent twice', async () => {
    const task = await seedTask();
    await service.dispatchDueReminders();

    const reloaded = await taskModel
      .findById(task._id)
      .setOptions({ isPlatformQuery: true } as any)
      .lean();
    expect(reloaded!.reminderSentAt).toBeInstanceOf(Date);
  });

  it('should send nothing on a second sweep', async () => {
    await seedTask();
    await service.dispatchDueReminders();
    const second = await service.dispatchDueReminders();

    expect(second).toEqual({ sent: 0, skipped: 0 });
    expect(redis.publish).toHaveBeenCalledTimes(1);
  });

  it('should send exactly once when two sweeps race', async () => {
    // What the claim exists for: `@Cron` fires in every process that loaded
    // ScheduleModule, so without a compare-and-set each replica would deliver its
    // own copy of the same reminder.
    await seedTask();

    await Promise.all([
      service.dispatchDueReminders(),
      service.dispatchDueReminders(),
    ]);

    expect(redis.publish).toHaveBeenCalledTimes(1);
  });

  it('should ignore a reminder that is not due yet', async () => {
    await seedTask({ reminderAt: new Date(Date.now() + 3_600_000) });
    expect(await service.dispatchDueReminders()).toEqual({
      sent: 0,
      skipped: 0,
    });
  });

  it('should ignore a task with no reminder set', async () => {
    await seedTask({ reminderAt: null });
    expect(await service.dispatchDueReminders()).toEqual({
      sent: 0,
      skipped: 0,
    });
  });

  it('should ignore a soft-deleted task', async () => {
    await seedTask({ deletedAt: new Date() });
    expect(await service.dispatchDueReminders()).toEqual({
      sent: 0,
      skipped: 0,
    });
  });

  it('should claim but does not deliver a badly stale reminder', async () => {
    // Waking up after an outage and firing a week of reminders is worse than
    // dropping them — and the drop is counted and logged rather than silent.
    await seedTask({
      reminderAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
    });

    const result = await service.dispatchDueReminders();

    expect(result).toEqual({ sent: 0, skipped: 1 });
    expect(redis.publish).not.toHaveBeenCalled();
  });

  it('should not retry after a delivery failure', async () => {
    // The claim is taken first and deliberately kept: there is no delivery receipt
    // to deduplicate against, so a retry would risk sending twice. The failure is
    // logged loudly instead of being hidden by a silent resend.
    redis.publish.mockRejectedValueOnce(new Error('redis down'));
    await seedTask();

    const first = await service.dispatchDueReminders();
    expect(first).toEqual({ sent: 0, skipped: 0 });

    const second = await service.dispatchDueReminders();
    expect(second).toEqual({ sent: 0, skipped: 0 });
  });

  it('should work across tenants in one sweep', async () => {
    const otherTenant = new Types.ObjectId().toString();
    await seedTask();
    await runWithTenant(otherTenant, async () =>
      taskModel.create({
        tenantId: otherTenant,
        title: 'Other tenant task',
        dueDate: new Date('2026-08-04T09:00:00Z'),
        priority: 'LOW',
        ownerId: owner,
        createdById: owner,
        updatedById: owner,
        reminderAt: new Date(Date.now() - 60_000),
      } as any),
    );

    // Cross-tenant by design — reminders come due for every tenant at once, which
    // is why the sweep is an explicit platform query.
    expect(await service.dispatchDueReminders()).toEqual({
      sent: 2,
      skipped: 0,
    });
  });
});
