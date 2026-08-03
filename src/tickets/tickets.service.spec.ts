import { HttpStatus, NotFoundException } from '@nestjs/common';
import { TICKET_ERRORS } from './constants/ticket-error-codes';
import { TicketsService } from './tickets.service';
import {
  createTicket,
  createTicketDto,
} from '../test/factories/ticket.factory';
import { createClsMock } from '../test/mocks/cls.mock';
import { createEventBusMock } from '../test/mocks/event-bus.mock';
import { createQueueMock } from '../test/mocks/queue.mock';
import { createMongooseModelMock } from '../test/mocks/mongoose-model.mock';
import { BadRequestException } from '@nestjs/common';
import { TICKET_MERGE_REFERENCES } from './ticket-references.registry';

describe('TicketsService', () => {
  let service: TicketsService;
  let repository: any;
  let cls: ReturnType<typeof createClsMock>;
  let eventEmitter: ReturnType<typeof createEventBusMock>;
  let connection: any;
  let updateMany: jest.Mock;
  let ticketSettingsService: any;

  beforeEach(() => {
    repository = {
      create: jest.fn(),
      findOne: jest.fn(),
      findManyWithPagination: jest.fn(),
      findManyByIds: jest.fn(),
      addTagsToTickets: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
      softDeleteInSession: jest.fn().mockResolvedValue(undefined),
      findParentId: jest.fn().mockResolvedValue(null),
      pauseSlaAtomic: jest.fn(),
      resumeSlaAtomic: jest.fn(),
      generateTicketNumber: jest.fn().mockResolvedValue('TKT-00001'),
    };

    cls = createClsMock();
    eventEmitter = createEventBusMock();

    ticketSettingsService = {
      findStatusById: jest.fn().mockResolvedValue(null),
    };

    // mergeTickets re-parents activity_logs and tasks through the raw connection.
    updateMany = jest.fn(() => Promise.resolve({ modifiedCount: 1 }));
    const session = {
      withTransaction: jest.fn(async (work: () => Promise<void>) => work()),
      endSession: jest.fn().mockResolvedValue(undefined),
    };
    connection = {
      collection: jest.fn(() => ({
        updateMany,
        findOne: jest.fn().mockResolvedValue({ _id: 'existing' }),
      })),
      startSession: jest.fn().mockResolvedValue(session),
    };

    service = new TicketsService(
      repository,
      ticketSettingsService,
      {
        runWithEvent: jest.fn(async (mutate: any, build: any) => {
          const result = await mutate(undefined);
          const payload = build(result);
          if (payload) {
            await eventEmitter.emitAsync(
              `${payload.event}.${payload.object}`,
              payload,
            );
          }
          return result;
        }),
      } as any,
      cls as any,
      { emit: jest.fn() } as any, // entityAudit
      {
        create: jest.fn().mockReturnValue({
          storeImportFile: jest.fn(),
          importFileExists: jest.fn(),
          readLocalReport: jest.fn(),
        }),
      } as any, // storageFactory
      createQueueMock() as any, // importQueue
      createQueueMock() as any, // exportQueue
      createMongooseModelMock() as any, // importJobModel
      {
        enqueue: jest.fn(),
        status: jest.fn(),
        cancel: jest.fn(),
        list: jest.fn(),
        download: jest.fn(),
      } as any, // exportRequest
      { validateTagIds: jest.fn().mockResolvedValue(undefined) } as any, // tagsService
      { getSetting: jest.fn().mockResolvedValue(null) } as any, // crmSettings
      connection as any, // connection — merge re-parents activity/tasks through it
      undefined,
      undefined,
      { canAccessRecord: jest.fn().mockResolvedValue(true) } as any,
    );
    jest
      .spyOn(service as any, 'validateTenantReferences')
      .mockResolvedValue(undefined);
  });

  describe('create', () => {
    it('should create ticket with auto-generated ticket number', async () => {
      const dto = createTicketDto();
      const expected = createTicket({ ...dto, ticketNumber: 'TKT-00001' });
      repository.create.mockResolvedValue(expected);

      const result = await service.create(dto as any);

      expect(repository.generateTicketNumber).toHaveBeenCalled();
      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          ticketNumber: 'TKT-00001',
          isSlaBreached: false,
          timeSpentSeconds: 0,
        }),
        undefined,
      );
      expect(result.ticketNumber).toBe('TKT-00001');
    });

    it('should emit automation event after creation', async () => {
      repository.create.mockResolvedValue(createTicket());

      await service.create(createTicketDto() as any);

      expect(eventEmitter.emitAsync).toHaveBeenCalledWith(
        expect.stringContaining('record_created'),
        expect.objectContaining({
          event: 'record_created',
          object: 'Ticket',
        }),
      );
    });

    it('should normalize empty ownerId to undefined', async () => {
      repository.create.mockResolvedValue(createTicket());

      await service.create({ ...createTicketDto(), ownerId: '' } as any);

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ ownerId: undefined }),
        undefined,
      );
    });

    it('should normalize empty groupId to undefined', async () => {
      repository.create.mockResolvedValue(createTicket());

      await service.create({ ...createTicketDto(), groupId: '' } as any);

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ groupId: undefined }),
        undefined,
      );
    });
  });

  describe('bulkTagTickets', () => {
    it('should reject operator-shaped ids before any repository call', async () => {
      await expect(
        service.bulkTagTickets({
          ticketIds: [{ $ne: null } as any],
          tags: ['60d0fe4f5311236168a109cc'],
        }),
      ).rejects.toThrow(BadRequestException);
      expect(repository.findManyByIds).not.toHaveBeenCalled();
    });

    it('should authorize every ticket before the bulk write', async () => {
      const tickets = [
        createTicket({ id: '60d0fe4f5311236168a109ca' }),
        createTicket({ id: '60d0fe4f5311236168a109cb' }),
      ];
      repository.findManyByIds.mockResolvedValue(tickets);
      repository.addTagsToTickets.mockResolvedValue({
        matchedCount: 2,
        modifiedCount: 2,
      });

      await service.bulkTagTickets({
        ticketIds: tickets.map((ticket) => ticket.id),
        tags: ['60d0fe4f5311236168a109cc'],
      });

      expect(
        (service as any).authorization.canAccessRecord,
      ).toHaveBeenCalledTimes(2);
      expect(repository.addTagsToTickets).toHaveBeenCalled();
    });

    it('should not partially write when one ticket is hidden', async () => {
      repository.findManyByIds.mockResolvedValue([
        createTicket({ id: '60d0fe4f5311236168a109ca' }),
      ]);

      await expect(
        service.bulkTagTickets({
          ticketIds: ['60d0fe4f5311236168a109ca', '60d0fe4f5311236168a109cb'],
          tags: ['60d0fe4f5311236168a109cc'],
        }),
      ).rejects.toThrow(NotFoundException);
      expect(repository.addTagsToTickets).not.toHaveBeenCalled();
    });
  });

  describe('tenant reference validation', () => {
    it('should reject a reference that is absent from the active tenant', async () => {
      (service as any).validateTenantReferences.mockRestore();
      connection.collection.mockReturnValue({
        findOne: jest.fn().mockResolvedValue(null),
      });

      await expect(
        (service as any).validateTenantReferences({
          contactId: '60d0fe4f5311236168a109ca',
        }),
      ).rejects.toThrow('does not reference an active record in this tenant');
    });

    it('should enforce record ACL on a referenced CRM record', async () => {
      (service as any).validateTenantReferences.mockRestore();
      (service as any).authorization.canAccessRecord.mockResolvedValueOnce(
        false,
      );

      await expect(
        (service as any).validateTenantReferences({
          dealId: '60d0fe4f5311236168a109ca',
        }),
      ).rejects.toMatchObject({ status: 404 });
    });

    it('should refuse a soft-deleted reference', async () => {
      (service as any).validateTenantReferences.mockRestore();
      const findOne = jest.fn().mockResolvedValue(null);
      connection.collection.mockReturnValue({ findOne });

      await expect(
        (service as any).validateTenantReferences({
          contactId: '60d0fe4f5311236168a109ca',
        }),
      ).rejects.toThrow('does not reference an active record in this tenant');
      expect(findOne.mock.calls[0][0]).toMatchObject({ deletedAt: null });
    });

    it('should hand the whole related record to the ACL check, not a label projection', async () => {
      (service as any).validateTenantReferences.mockRestore();
      const record = {
        _id: '60d0fe4f5311236168a109ca',
        name: 'Acme renewal',
        ownerId: 'u1',
      };
      const findOne = jest.fn().mockResolvedValue(record);
      connection.collection.mockReturnValue({ findOne });

      const data: any = {
        relatedTo: {
          type: 'Deal',
          _id: '60d0fe4f5311236168a109ca',
          name: 'stale label',
        },
      };
      await (service as any).validateTenantReferences(data);

      expect(findOne).toHaveBeenCalledWith(
        expect.objectContaining({ deletedAt: null }),
      );
      expect(
        (service as any).authorization.canAccessRecord,
      ).toHaveBeenCalledWith(expect.objectContaining({ record }));
      // The stored label comes from the database, never from the request body.
      expect(data.relatedTo.name).toBe('Acme renewal');
    });
  });

  describe('findOne', () => {
    it('should return ticket by id', async () => {
      const ticket = createTicket();
      repository.findOne.mockResolvedValue(ticket);

      const result = await service.findOne('ticket_1');

      expect(repository.findOne).toHaveBeenCalledWith({ _id: 'ticket_1' });
      expect(result).toEqual(ticket);
    });

    it('should return null for non-existent ticket', async () => {
      repository.findOne.mockResolvedValue(null);
      expect(await service.findOne('bad_id')).toBeNull();
    });
  });

  describe('findAll', () => {
    it('should apply pagination defaults', async () => {
      repository.findManyWithPagination.mockResolvedValue({
        data: [],
        totalItems: 0,
      });

      await service.findAll({ page: 1, limit: 10 });

      expect(repository.findManyWithPagination).toHaveBeenCalledWith(
        expect.objectContaining({
          paginationOptions: { page: 1, limit: 10 },
        }),
      );
    });

    it('should default to page 1 and limit 20 when not provided', async () => {
      repository.findManyWithPagination.mockResolvedValue({ data: [] });

      await service.findAll({});

      expect(repository.findManyWithPagination).toHaveBeenCalledWith(
        expect.objectContaining({
          paginationOptions: { page: 1, limit: 20 },
        }),
      );
    });

    it('should reject malformed list filters', async () => {
      await expect(service.findAll({ filters: '{bad json' })).rejects.toThrow(
        'filters must be valid JSON',
      );
      expect(repository.findManyWithPagination).not.toHaveBeenCalled();
    });

    it('should reject Mongo operators in statusIds', async () => {
      await expect(
        service.findAll({ statusIds: [{ $ne: null }] }),
      ).rejects.toThrow('statusIds must be a comma-separated string');
      expect(repository.findManyWithPagination).not.toHaveBeenCalled();
    });
  });

  // MERGE — the same C-1 defect the contact audit found
  describe('mergeTickets', () => {
    // Real ObjectId hex, not 'target'/'source'. The registry casts ids for
    // ObjectId-kind references, so a placeholder throws inside the re-parent loop —
    // where the per-reference catch swallows it. The test then passed while asserting
    // against the failure path, which is how the child-ticket reference looked covered.
    const TARGET_ID = '60d0fe4f5311236168a109ca';
    const SOURCE_ID = '60d0fe4f5311236168a109cb';

    const target = () =>
      createTicket({
        id: TARGET_ID,
        description: 'Original',
        linkedMessageIds: ['m1'],
      } as any);
    const source = () =>
      createTicket({
        id: SOURCE_ID,
        ticketNumber: 'TKT-00009',
        linkedMessageIds: ['m2', 'm1'],
      } as any);

    beforeEach(() => {
      repository.findOne.mockImplementation((f: any) =>
        Promise.resolve(String(f._id) === TARGET_ID ? target() : source()),
      );
      repository.update.mockResolvedValue(target());
    });

    it('should refuse to merge a ticket with itself', async () => {
      await expect(service.mergeTickets('t1', 't1')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should refuse to delete a source denied by its record ACL', async () => {
      (service as any).authorization.canAccessRecord.mockResolvedValueOnce(
        false,
      );

      await expect(
        service.mergeTickets(TARGET_ID, SOURCE_ID),
      ).rejects.toMatchObject({ status: 404 });
      expect(connection.startSession).not.toHaveBeenCalled();
    });

    it('should carry the source linked messages onto the target', async () => {
      // Without this the merge only appended a sentence to the description: the
      // conversation messages stayed linked to a ticket about to be archived, so the
      // agent lost the very thread they merged the duplicate for.
      await service.mergeTickets(TARGET_ID, SOURCE_ID);

      const payload = repository.update.mock.calls[0][1];
      expect(payload.linkedMessageIds.sort()).toEqual(['m1', 'm2']);
    });

    it('should de-duplicate messages linked to both tickets', async () => {
      await service.mergeTickets(TARGET_ID, SOURCE_ID);
      const ids = repository.update.mock.calls[0][1].linkedMessageIds;
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('should re-parent the source timeline onto the target', async () => {
      await service.mergeTickets(TARGET_ID, SOURCE_ID);

      expect(connection.collection).toHaveBeenCalledWith('activity_logs');
      const activityCall = updateMany.mock.calls.find(
        ([filter]: any[]) => filter.targetType === 'ticket',
      );
      expect(activityCall?.[0].targetId).toBe(SOURCE_ID);
      expect(activityCall?.[1]).toEqual({ $set: { targetId: TARGET_ID } });
    });

    it('should re-parent related tasks, matching both relatedTo key shapes', async () => {
      await service.mergeTickets(TARGET_ID, SOURCE_ID);

      expect(connection.collection).toHaveBeenCalledWith('tasks');
      const taskCall = updateMany.mock.calls.find(
        ([filter]: any[]) => filter['relatedTo.type'] === 'Ticket',
      );
      expect(taskCall?.[0].$or).toEqual([
        { 'relatedTo._id': SOURCE_ID },
        { 'relatedTo.id': SOURCE_ID },
      ]);
    });

    it('should soft-delete the source, which its own comment always claimed', async () => {
      // `remove()` used to hard-delete; the comment said "soft-delete source ticket".
      await service.mergeTickets(TARGET_ID, SOURCE_ID);
      expect(repository.softDeleteInSession).toHaveBeenCalledWith(
        SOURCE_ID,
        expect.anything(),
      );
    });

    it('should re-parent CHILD tickets, which the hand-rolled version missed', async () => {
      // Merging a parent used to leave its children pointing at a soft-deleted ticket:
      // unreachable rather than deleted, which is the original merge defect reappearing
      // in a domain that had already been fixed once. The registry declares the
      // reference; the loop now reads the registry instead of a hard-coded pair.
      await service.mergeTickets(TARGET_ID, SOURCE_ID);

      expect(connection.collection).toHaveBeenCalledWith('tickets');
      const childCall = updateMany.mock.calls.find(
        ([filter]: any[]) => filter.parentTicketId !== undefined,
      );
      expect(String(childCall?.[0].parentTicketId)).toBe(SOURCE_ID);
    });

    it('should re-parent agent time segments, so occupancy follows the survivor', async () => {
      // Minutes an agent worked on the duplicate belong to the ticket that survives it;
      // left behind, workforce reporting undercounts the surviving ticket forever.
      await service.mergeTickets(TARGET_ID, SOURCE_ID);

      expect(connection.collection).toHaveBeenCalledWith(
        'interaction_segments',
      );
    });

    it('should NEVER move the audit trail', async () => {
      // Excluded by policy (`onMerge: 'keep'`), not by omission — it records what
      // happened to a specific ticket id, and rewriting it would falsify the history of
      // the very operation doing the rewriting.
      await service.mergeTickets(TARGET_ID, SOURCE_ID);
      expect(connection.collection).not.toHaveBeenCalledWith('audit_logs');
    });

    it('should move every reference the registry marks reparent', async () => {
      await service.mergeTickets(TARGET_ID, SOURCE_ID);

      const touched = connection.collection.mock.calls.map(
        ([name]: any[]) => name,
      );
      for (const ref of TICKET_MERGE_REFERENCES) {
        expect(touched).toContain(ref.collection);
      }
    });

    it('should abort when a re-parent collection fails', async () => {
      // The merge has already committed by that point, so throwing would tell the
      // caller it failed when the target was in fact updated.
      updateMany.mockRejectedValue(new Error('mongo down'));
      await expect(service.mergeTickets(TARGET_ID, SOURCE_ID)).rejects.toThrow(
        'mongo down',
      );
      expect(repository.softDeleteInSession).not.toHaveBeenCalled();
    });
  });

  // UPDATE — Status Transition Guard
  describe('update', () => {
    it('should update ticket with valid data', async () => {
      const existing = createTicket();
      const updated = createTicket({ subject: 'Updated subject' });
      repository.findOne.mockResolvedValue(existing);
      repository.update.mockResolvedValue(updated);

      const result = await service.update('ticket_1', {
        subject: 'Updated subject',
      } as any);

      expect(result?.subject).toBe('Updated subject');
    });

    it('should block reopening terminal status without allowReopen flag', async () => {
      const existing = createTicket({ statusId: 'resolved' });
      repository.findOne.mockResolvedValue(existing);
      ticketSettingsService.findStatusById
        .mockResolvedValueOnce({ isTerminal: true, label: 'Resolved' }) // old
        .mockResolvedValueOnce({ isTerminal: false, label: 'Open' }); // new

      await expect(
        service.update('ticket_1', { statusId: 'open' } as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('should allow reopening terminal status with allowReopen=true', async () => {
      const existing = createTicket({ statusId: 'resolved' });
      repository.findOne.mockResolvedValue(existing);
      repository.update.mockResolvedValue(createTicket({ statusId: 'open' }));
      ticketSettingsService.findStatusById
        .mockResolvedValueOnce({ isTerminal: true, label: 'Resolved' })
        .mockResolvedValueOnce({ isTerminal: false, label: 'Open' });

      const result = await service.update('ticket_1', {
        statusId: 'open',
        allowReopen: true,
      } as any);

      expect(result?.statusId).toBe('open');
    });

    it('should auto-set resolvedAt/closedAt when transitioning to terminal status', async () => {
      const existing = createTicket({ statusId: 'open' });
      repository.findOne.mockResolvedValue(existing);
      repository.update.mockResolvedValue(createTicket({ statusId: 'closed' }));
      ticketSettingsService.findStatusById
        .mockResolvedValueOnce({ isTerminal: false, label: 'Open' })
        .mockResolvedValueOnce({ isTerminal: true, label: 'Closed' });

      await service.update('ticket_1', { statusId: 'closed' } as any);

      expect(repository.update).toHaveBeenCalledWith(
        'ticket_1',
        expect.objectContaining({
          resolvedAt: expect.any(Date),
          closedAt: expect.any(Date),
        }),
        undefined,
      );
    });

    it('should emit automation event on field update', async () => {
      repository.findOne.mockResolvedValue(createTicket());
      repository.update.mockResolvedValue(createTicket({ priority: 'HIGH' }));

      await service.update('ticket_1', { priority: 'HIGH' } as any);

      expect(eventEmitter.emitAsync).toHaveBeenCalledWith(
        expect.stringContaining('field_updated'),
        expect.objectContaining({
          event: 'field_updated',
          object: 'Ticket',
        }),
      );
    });
  });

  // DELETE
  describe('remove', () => {
    it('should delete ticket by id', async () => {
      repository.remove.mockResolvedValue(undefined);
      await service.remove('ticket_1');
      expect(repository.remove).toHaveBeenCalledWith('ticket_1');
    });
  });

  // IMPORT VALIDATION
  describe('uploadImportFile', () => {
    it('should throw when no file provided', async () => {
      await expect(service.uploadImportFile(null as any)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw when file exceeds size limit', async () => {
      await expect(
        service.uploadImportFile({
          buffer: Buffer.alloc(100 * 1024 * 1024), // 100MB
          originalname: 'huge.csv',
          size: 100 * 1024 * 1024,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject a renamed non-XLSX binary', async () => {
      await expect(
        service.uploadImportFile({
          buffer: Buffer.from('not a zip workbook'),
          originalname: 'fake.xlsx',
          size: 18,
        }),
      ).rejects.toThrow('Invalid XLSX file signature');
    });

    it('should reject binary content renamed as CSV', async () => {
      await expect(
        service.uploadImportFile({
          buffer: Buffer.from([0x61, 0, 0x62]),
          originalname: 'fake.csv',
          size: 3,
        }),
      ).rejects.toThrow('CSV file contains binary data');
    });
  });

  describe('startImport', () => {
    it('should throw when mapping does not include subject', async () => {
      await expect(
        service.startImport({
          fileKey: 'test.csv',
          mapping: { Column1: 'description' },
        } as any),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('deal link', () => {
    // The whole feature was inert: `dealId` was absent from the schema (so Mongoose
    // strict mode dropped every write), absent from the mapper (so `update()` would have
    // dropped it anyway), and ignored by the list filter — which made
    // `GET /tickets/by-deal/:dealId` answer with every ticket in the tenant and look
    // like it had worked.
    it('should write dealId when linking', async () => {
      const dealId = '60d0fe4f5311236168a109cc';
      repository.findOne.mockResolvedValue({ id: 't1', subject: 'S' });
      repository.update.mockResolvedValue({ id: 't1', dealId });

      const result = await service.linkDeal('t1', dealId);

      expect(repository.update).toHaveBeenCalledWith(
        't1',
        expect.objectContaining({ dealId }),
      );
      expect(result.dealId).toBe(dealId);
    });

    it('should be idempotent when the link already exists', async () => {
      const dealId = '60d0fe4f5311236168a109cc';
      repository.findOne.mockResolvedValue({ id: 't1', dealId });

      await service.linkDeal('t1', dealId);

      expect(repository.update).not.toHaveBeenCalled();
    });

    it('should write an explicit null when unlinking', async () => {
      // Not `undefined`, and not omitted: the mapper only writes keys it is given, so an
      // omitted field would leave the old link in place and make unlink a silent no-op.
      repository.findOne.mockResolvedValue({ id: 't1', dealId: 'd1' });
      repository.update.mockResolvedValue({ id: 't1', dealId: null });

      await service.unlinkDeal('t1');

      expect(repository.update).toHaveBeenCalledWith(
        't1',
        expect.objectContaining({ dealId: null }),
      );
    });

    it('should 404 rather than link a ticket that does not exist', async () => {
      repository.findOne.mockResolvedValue(null);
      await expect(
        service.linkDeal('nope', '60d0fe4f5311236168a109cc'),
      ).rejects.toMatchObject({
        errorCode: TICKET_ERRORS.NOT_FOUND,
        status: HttpStatus.NOT_FOUND,
      });
    });

    it('should pass dealId to the repository when listing a deal tickets', async () => {
      repository.findManyWithPagination.mockResolvedValue({ data: [] });

      await service.findByDeal('d1');

      // The filter has to REACH the query — an ignored one returns unrelated rows.
      expect(repository.findManyWithPagination).toHaveBeenCalledWith(
        expect.objectContaining({
          filterOptions: expect.objectContaining({ dealId: 'd1' }),
        }),
      );
    });
  });

  describe('SLA concurrency safety', () => {
    it('should pause through the conditional atomic repository operation', async () => {
      const ticket = createTicket({ slaPausedAt: undefined } as any);
      const paused = createTicket({ slaPausedAt: new Date() } as any);
      repository.findOne.mockResolvedValue(ticket);
      repository.pauseSlaAtomic.mockResolvedValue(paused);

      await expect(service.pauseSla(ticket.id)).resolves.toBe(paused);
      expect(repository.pauseSlaAtomic).toHaveBeenCalledWith(
        ticket.id,
        expect.any(Date),
      );
      expect(repository.update).not.toHaveBeenCalled();
    });

    it('should resume through one atomic calculation and write', async () => {
      const ticket = createTicket({
        slaPausedAt: new Date(Date.now() - 5_000),
        slaResumedAt: undefined,
      } as any);
      const resumed = createTicket({
        slaPausedAt: (ticket as any).slaPausedAt,
        slaResumedAt: new Date(),
        slaPausedSeconds: 5,
      } as any);
      repository.findOne.mockResolvedValue(ticket);
      repository.resumeSlaAtomic.mockResolvedValue(resumed);

      await expect(service.resumeSla(ticket.id)).resolves.toBe(resumed);
      expect(repository.resumeSlaAtomic).toHaveBeenCalledWith(
        ticket.id,
        expect.any(Date),
      );
      expect(repository.update).not.toHaveBeenCalled();
    });
  });
});
