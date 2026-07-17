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

describe('TicketsService', () => {
  let service: TicketsService;
  let repository: any;
  let cls: ReturnType<typeof createClsMock>;
  let eventEmitter: ReturnType<typeof createEventBusMock>;
  let ticketSettingsService: any;

  beforeEach(() => {
    repository = {
      create: jest.fn(),
      findOne: jest.fn(),
      findManyWithPagination: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
      generateTicketNumber: jest.fn().mockResolvedValue('TKT-00001'),
    };

    cls = createClsMock();
    eventEmitter = createEventBusMock();

    ticketSettingsService = {
      findStatusById: jest.fn().mockResolvedValue(null),
    };

    service = new TicketsService(
      repository,
      ticketSettingsService,
      eventEmitter as any,
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
    );
  });

  // ═══════════════════════════════════════════════════════════════════
  // CREATE
  // ═══════════════════════════════════════════════════════════════════
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
      );
      expect(result.ticketNumber).toBe('TKT-00001');
    });

    it('should emit automation event after creation', async () => {
      repository.create.mockResolvedValue(createTicket());

      await service.create(createTicketDto() as any);

      expect(eventEmitter.emit).toHaveBeenCalledWith(
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
      );
    });

    it('should normalize empty groupId to undefined', async () => {
      repository.create.mockResolvedValue(createTicket());

      await service.create({ ...createTicketDto(), groupId: '' } as any);

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ groupId: undefined }),
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // FIND
  // ═══════════════════════════════════════════════════════════════════
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

    it('should default to page 1 and limit 10 when not provided', async () => {
      repository.findManyWithPagination.mockResolvedValue({ data: [] });

      await service.findAll({});

      expect(repository.findManyWithPagination).toHaveBeenCalledWith(
        expect.objectContaining({
          paginationOptions: { page: 1, limit: 10 },
        }),
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // UPDATE — Status Transition Guard
  // ═══════════════════════════════════════════════════════════════════
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
      );
    });

    it('should emit automation event on field update', async () => {
      repository.findOne.mockResolvedValue(createTicket());
      repository.update.mockResolvedValue(createTicket({ priority: 'HIGH' }));

      await service.update('ticket_1', { priority: 'HIGH' } as any);

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        expect.stringContaining('field_updated'),
        expect.objectContaining({
          event: 'field_updated',
          object: 'Ticket',
        }),
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // DELETE
  // ═══════════════════════════════════════════════════════════════════
  describe('remove', () => {
    it('should delete ticket by id', async () => {
      repository.remove.mockResolvedValue(undefined);
      await service.remove('ticket_1');
      expect(repository.remove).toHaveBeenCalledWith('ticket_1');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // IMPORT VALIDATION
  // ═══════════════════════════════════════════════════════════════════
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
});
