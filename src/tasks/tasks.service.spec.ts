import {
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { TasksService } from './tasks.service';
import { Task } from './domain/task';

/**
 * TasksService — the rules the HTTP surface must enforce.
 *
 * Unit-level with a fake repository, because what is under test is the ORDER and
 * the CONTENT of the service's decisions: refuse before validating, validate
 * references before writing, derive `completedAt` on the server, carry a version
 * predicate, and record the right audit kind. None of that needs a database, and
 * the module previously had no test of any of it — its single spec covered export
 * enqueueing.
 */

const OPEN = 'aaaaaaaaaaaaaaaaaaaaaaa1';
const DONE = 'aaaaaaaaaaaaaaaaaaaaaaa2';

function build(
  overrides: {
    existing?: Partial<Task> | null;
    statuses?: Map<string, { isTerminal: boolean }>;
    updateResult?: Partial<Task> | null;
    referencesThrows?: Error;
  } = {},
) {
  const statuses =
    overrides.statuses ??
    new Map([
      [OPEN, { isTerminal: false }],
      [DONE, { isTerminal: true }],
    ]);

  const repository = {
    findOne: jest.fn().mockResolvedValue(
      overrides.existing === undefined
        ? {
            id: 't1',
            statusId: OPEN,
            createdAt: new Date('2026-08-01'),
            version: 4,
          }
        : overrides.existing,
    ),
    create: jest
      .fn()
      .mockImplementation((data: any) => ({ id: 'new', ...data })),
    update: jest
      .fn()
      .mockResolvedValue(
        overrides.updateResult === undefined
          ? { id: 't1', statusId: OPEN }
          : overrides.updateResult,
      ),
    remove: jest.fn().mockResolvedValue(undefined),
    restore: jest.fn().mockResolvedValue({ id: 't1' }),
    findDeleted: jest.fn().mockResolvedValue({ data: [], total: 0 }),
    findManyWithPagination: jest.fn().mockResolvedValue({ data: [] }),
  };

  const entityAudit = { emit: jest.fn() };
  const cls = {
    get: jest.fn((key: string) =>
      key === 'activeTenantId' || key === 'tenantId' ? 'tenant-1' : 'user-1',
    ),
  };
  // Runs the mutation immediately and captures the event the service built, which
  // is what the assertions inspect.
  const automationOutbox = {
    events: [] as any[],
    runWithEvent: jest.fn(async (mutate: any, buildPayload: any) => {
      const result = await mutate({} as any);
      automationOutboxRef.events.push(buildPayload(result));
      return result;
    }),
  };
  const automationOutboxRef = automationOutbox;

  const references = {
    resolve: jest.fn().mockImplementation(() => {
      if (overrides.referencesThrows) {
        return Promise.reject(overrides.referencesThrows);
      }
      return Promise.resolve({ statuses });
    }),
  };

  const service = new TasksService(
    repository as any,
    entityAudit as any,
    cls as any,
    automationOutbox as any,
    {} as any,
    {} as any,
    references as any,
    undefined,
    undefined,
  );

  return { service, repository, entityAudit, automationOutbox, references };
}

describe('TasksService', () => {
  describe('create', () => {
    it('should validate references BEFORE writing', async () => {
      const { service, repository, references } = build({
        referencesThrows: new UnprocessableEntityException('bad owner'),
      });

      await expect(
        service.create({ title: 'x', ownerId: 'nope' } as Partial<Task>),
      ).rejects.toThrow(UnprocessableEntityException);

      expect(references.resolve).toHaveBeenCalled();
      // The point of the ordering: an invalid owner must not reach the database.
      expect(repository.create).not.toHaveBeenCalled();
    });

    it('should stamp completedAt when created directly in a terminal status', async () => {
      const { service, repository } = build();
      await service.create({ title: 'x', statusId: DONE } as Partial<Task>);
      const written = repository.create.mock.calls[0][0];
      expect(written.completedAt).toBeInstanceOf(Date);
    });

    it('should seed nextOccurrenceAt for a recurring task', async () => {
      // Without this the scheduler — which selects on nextOccurrenceAt — never sees
      // the template, and a "recurring" task recurs zero times.
      const { service, repository } = build();
      const dueDate = new Date('2026-09-04T09:00:00Z');
      await service.create({
        title: 'weekly sync',
        dueDate,
        isRecurring: true,
        recurrenceRule: 'weekly',
      } as Partial<Task>);

      const written = repository.create.mock.calls[0][0];
      expect(written.isRecurring).toBe(true);
      expect(written.nextOccurrenceAt).toEqual(dueDate);
    });

    it('should refuse a recurring task with no rule', async () => {
      const { service } = build();
      await expect(
        service.create({
          title: 'x',
          dueDate: new Date(),
          isRecurring: true,
        } as Partial<Task>),
      ).rejects.toThrow(UnprocessableEntityException);
    });

    it('should emit a record_created automation event', async () => {
      const { service, automationOutbox } = build();
      await service.create({ title: 'x' } as Partial<Task>);
      expect(automationOutbox.events[0]).toMatchObject({
        event: 'record_created',
        object: 'Task',
        tenantId: 'tenant-1',
      });
    });
  });

  describe('update', () => {
    it('should answer 404 when the record is outside the caller scope', async () => {
      const { service, repository } = build({ existing: null });
      await expect(service.update('t1', { title: 'x' })).rejects.toThrow(
        NotFoundException,
      );
      expect(repository.update).not.toHaveBeenCalled();
    });

    it('should carry a version predicate so the write is a compare-and-set', async () => {
      const { service, repository } = build();
      await service.update('t1', { title: 'renamed' });
      // Falls back to the revision just read when the client sent none.
      expect(repository.update.mock.calls[0][1].version).toBe(4);
    });

    it('should prefer the version the client supplied', async () => {
      const { service, repository } = build();
      await service.update('t1', { title: 'renamed', version: 2 });
      // A stale value is the whole point: the repository turns it into a filter
      // that matches nothing and answers 409.
      expect(repository.update.mock.calls[0][1].version).toBe(2);
    });

    it('should clear completedAt when a completed task is reopened', async () => {
      const { service, repository } = build({
        existing: {
          id: 't1',
          statusId: DONE,
          completedAt: new Date('2026-08-02'),
          createdAt: new Date('2026-08-01'),
          version: 1,
        },
      });
      await service.update('t1', { statusId: OPEN });
      expect(repository.update.mock.calls[0][1].completedAt).toBeNull();
    });

    it('should refuse to reschedule a completed task', async () => {
      const { service, repository } = build({
        existing: {
          id: 't1',
          statusId: DONE,
          createdAt: new Date('2026-08-01'),
          version: 1,
        },
      });
      await expect(
        service.update('t1', { dueDate: new Date('2027-01-01') }),
      ).rejects.toThrow(UnprocessableEntityException);
      expect(repository.update).not.toHaveBeenCalled();
    });

    it('should exclude `version` from the changed-field list on the event', async () => {
      // `version` is a concurrency token, not a business field; listing it would
      // fire every `field_updated` workflow watching for real changes.
      const { service, automationOutbox } = build();
      await service.update('t1', { title: 'renamed', version: 4 });
      expect(automationOutbox.events[0].changedFields).toEqual(['title']);
    });
  });

  describe('remove', () => {
    it('should answer 404 instead of reporting success for a record it cannot see', async () => {
      const { service, repository } = build({ existing: null });
      await expect(service.remove('t1')).rejects.toThrow(NotFoundException);
      expect(repository.remove).not.toHaveBeenCalled();
    });

    it("should record the audit entry as 'deleted', not 'updated'", async () => {
      // The old value made "who deleted this task" unanswerable from the audit log.
      const { service, entityAudit } = build();
      await service.remove('t1');
      expect(entityAudit.emit).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'deleted', entityType: 'TASK' }),
      );
    });

    it('should emit a deletedAt field_updated event for workflows', async () => {
      const { service, automationOutbox } = build();
      await service.remove('t1');
      expect(automationOutbox.events[0]).toMatchObject({
        event: 'field_updated',
        changedFields: ['deletedAt'],
      });
    });
  });

  describe('restore', () => {
    it("should record the audit entry as 'restored'", async () => {
      const { service, entityAudit } = build();
      await service.restore('t1');
      expect(entityAudit.emit).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'restored' }),
      );
    });

    it('should answer 404 when nothing is in the recycle bin', async () => {
      const { service, repository } = build();
      repository.restore.mockResolvedValue(null);
      await expect(service.restore('t1')).rejects.toThrow(NotFoundException);
    });
  });

  describe('findOne', () => {
    it('should answer 404 rather than answering 200 with a null body', async () => {
      const { service } = build({ existing: null });
      await expect(service.findOne('t1')).rejects.toThrow(NotFoundException);
    });
  });

  describe('findAll', () => {
    it('should clamp limit to the module ceiling', async () => {
      // Second line of defence behind the DTO: ContactsController reaches this
      // method with its own DTO, and internal callers have none.
      const { service, repository } = build();
      await service.findAll({ limit: 1_000_000 } as any);
      expect(
        repository.findManyWithPagination.mock.calls[0][0].paginationOptions
          .limit,
      ).toBe(100);
    });

    it('should fall back to the default limit when none is given', async () => {
      const { service, repository } = build();
      await service.findAll({} as any);
      expect(
        repository.findManyWithPagination.mock.calls[0][0].paginationOptions
          .limit,
      ).toBe(25);
    });
  });

  describe('bulkUpdate', () => {
    it('should refuse a payload with no changes', async () => {
      const { service } = build();
      await expect(service.bulkUpdate({ ids: ['a'] } as any)).rejects.toThrow(
        UnprocessableEntityException,
      );
    });

    it('should report per-id outcomes instead of failing the whole request', async () => {
      const { service, repository } = build();
      repository.findOne
        .mockResolvedValueOnce({ id: 'a', statusId: OPEN, version: 1 })
        .mockResolvedValueOnce(null); // 'b' is outside the caller's scope

      const result = await service.bulkUpdate({
        ids: ['a', 'b'],
        priority: 'HIGH',
      } as any);

      expect(result.updated).toBe(1);
      expect(result.skipped).toEqual([
        { id: 'b', reason: 'Không tồn tại hoặc ngoài phạm vi truy cập.' },
      ]);
    });

    it('should surface a concurrency clash as a per-id skip', async () => {
      const { service, repository } = build();
      repository.update.mockRejectedValueOnce(new ConflictException('changed'));
      const result = await service.bulkUpdate({
        ids: ['a'],
        priority: 'LOW',
      } as any);
      expect(result.updated).toBe(0);
      expect(result.skipped[0].reason).toMatch(/tải lại/);
    });

    it('should audit every record it touches', async () => {
      // A bulk path that skipped auditing would be a way to change many records
      // without a trail — which is why this loops the single-record method.
      const { service, entityAudit } = build();
      await service.bulkUpdate({ ids: ['a', 'b'], priority: 'HIGH' } as any);
      expect(entityAudit.emit).toHaveBeenCalledTimes(2);
    });
  });
});
