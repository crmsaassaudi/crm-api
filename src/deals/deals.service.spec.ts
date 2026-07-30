import {
  BadRequestException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import { DEAL_ERRORS } from './constants/deal-error-codes';
import { DealsService } from './deals.service';
import { createClsMock } from '../test/mocks/cls.mock';
import { createEventBusMock } from '../test/mocks/event-bus.mock';

/**
 * DealsService — Phase 3 unit tests
 *
 * Covers: CRUD with audit trail, ownerId sanitization,
 * import upload validation, startImport field mapping validation,
 * deduplication matching field validation, import status tenant isolation.
 */
describe('DealsService', () => {
  let service: DealsService;
  let repository: any;
  let cls: ReturnType<typeof createClsMock>;
  let eventEmitter: ReturnType<typeof createEventBusMock>;
  let entityAudit: any;
  let importStorage: any;
  let importQueue: any;
  let exportQueue: any;
  let importJobModel: any;
  let exportRequest: any;
  let stageModel: any;
  let stages: Record<string, any>;

  beforeEach(() => {
    repository = {
      create: jest
        .fn()
        .mockImplementation((data) =>
          Promise.resolve({ id: 'deal_new', ...data }),
        ),
      findOne: jest.fn().mockResolvedValue(null),
      findManyWithPagination: jest
        .fn()
        .mockResolvedValue({ data: [], hasNextPage: false }),
      update: jest
        .fn()
        .mockImplementation((id, data) => Promise.resolve({ id, ...data })),
      remove: jest.fn().mockResolvedValue(undefined),
    };

    cls = createClsMock();
    eventEmitter = createEventBusMock();

    entityAudit = {
      emit: jest.fn(),
    };

    importStorage = {
      storeImportFile: jest
        .fn()
        .mockResolvedValue({ fileKey: 'deals/test.csv' }),
      importFileExists: jest.fn().mockResolvedValue(true),
    };

    const storageFactory = {
      create: jest.fn().mockReturnValue(importStorage),
    };

    importQueue = {
      add: jest.fn().mockResolvedValue({ id: 'bull_job_1' }),
      getJob: jest.fn().mockResolvedValue(null),
    };

    exportQueue = {
      add: jest.fn().mockResolvedValue({ id: 'export_1' }),
    };

    importJobModel = {
      create: jest.fn().mockResolvedValue({}),
    };

    stages = {};
    stageModel = {
      findById: jest.fn((id: string) => ({
        lean: () => ({
          exec: () => Promise.resolve(stages[String(id)] ?? null),
        }),
      })),
    };

    exportRequest = {
      enqueue: jest
        .fn()
        .mockResolvedValue({ jobId: 'exp_1', status: 'queued' }),
      status: jest.fn(),
      cancel: jest.fn(),
      list: jest.fn(),
      download: jest.fn(),
    };

    service = new DealsService(
      repository,
      // customFieldValidator: pass-through; its own behaviour is covered in its spec.
      {
        validate: jest.fn((_m: string, v: any) => Promise.resolve(v)),
      } as any,
      cls as any,
      {
        runWithEvent: jest.fn(async (mutate: any, build: any) => {
          const result = await mutate(undefined);
          const payload = build(result);
          if (payload) await eventEmitter.emitAsync('automation', payload);
          return result;
        }),
      } as any,
      entityAudit,
      storageFactory as any,
      importQueue,
      exportQueue,
      importJobModel,
      // stageModel: the tenant's pipeline stages. `stages` (below) is the fixture each
      // test can point at; the default is an empty pipeline, which means no stage is
      // terminal and the guard has nothing to guard — the pre-existing behaviour.
      stageModel,
      exportRequest,
      { getSetting: jest.fn().mockResolvedValue(null) } as any, // crmSettings
      { validateTagIds: jest.fn().mockResolvedValue(undefined) } as any, // tagsService
    );
  });

  // ═══════════════════════════════════════════════════════════════════
  // CRUD
  // ═══════════════════════════════════════════════════════════════════
  describe('create', () => {
    it('should create deal with name from title', async () => {
      const result = await service.create({
        title: 'Enterprise License',
        value: 50000,
      } as any);

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Enterprise License' }),
        undefined,
      );
      expect(result.id).toBe('deal_new');
    });

    it('should sanitize empty ownerId to undefined', async () => {
      await service.create({ title: 'Deal', ownerId: '' } as any);

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ ownerId: undefined }),
        undefined,
      );
    });
  });

  describe('update', () => {
    it('should emit audit trail on update', async () => {
      const existingDeal = { id: 'deal_1', name: 'Old Name', value: 1000 };
      repository.findOne.mockResolvedValueOnce(existingDeal);

      await service.update('deal_1', { title: 'New Name', value: 5000 } as any);

      expect(entityAudit.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          entity: 'deal',
          entityType: 'DEAL',
          entityId: 'deal_1',
          kind: 'updated',
          oldSnapshot: existingDeal,
          newSnapshot: expect.objectContaining({ id: 'deal_1' }),
        }),
      );
    });

    it('should NOT emit audit if update returns null', async () => {
      repository.update.mockResolvedValueOnce(null);

      await service.update('nonexistent', { title: 'X' } as any);

      expect(entityAudit.emit).not.toHaveBeenCalled();
    });
  });

  describe('findAll', () => {
    it('should pass pagination defaults', async () => {
      await service.findAll({});

      expect(repository.findManyWithPagination).toHaveBeenCalledWith(
        expect.objectContaining({
          paginationOptions: { page: 1, limit: 10 },
        }),
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // IMPORT — upload validation
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
          originalname: 'big.csv',
          size: 100 * 1024 * 1024,
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // IMPORT — startImport validation
  // ═══════════════════════════════════════════════════════════════════
  describe('startImport', () => {
    it('should throw when mapping is missing required title field', async () => {
      await expect(
        service.startImport({
          fileKey: 'deals/test.csv',
          mapping: { col1: 'value' },
        } as any),
      ).rejects.toThrow('mapping must include title');
    });

    it('should throw when mapping contains invalid fields', async () => {
      await expect(
        service.startImport({
          fileKey: 'deals/test.csv',
          mapping: { col1: 'title', col2: 'INVALID_FIELD' },
        } as any),
      ).rejects.toThrow(/Invalid mapping target/);
    });

    it('should throw on unsupported deduplication fields', async () => {
      await expect(
        service.startImport({
          fileKey: 'deals/test.csv',
          mapping: { col1: 'title' },
          deduplication: { matchingFields: ['unsupported_field'] },
        } as any),
      ).rejects.toThrow(/Unsupported dedup matchingFields/);
    });

    it('should throw when uploaded file no longer exists', async () => {
      importStorage.importFileExists.mockResolvedValueOnce(false);

      await expect(
        service.startImport({
          fileKey: 'deals/expired.csv',
          mapping: { col1: 'title' },
        } as any),
      ).rejects.toThrow('fileKey not found in storage');
    });

    it('should enqueue import job with tenant context', async () => {
      const result = await service.startImport({
        fileKey: 'deals/test.csv',
        mapping: { col1: 'title' },
      } as any);

      expect(importQueue.add).toHaveBeenCalledWith(
        'import',
        expect.objectContaining({
          tenantId: 'tenant_1',
          fileKey: 'deals/test.csv',
        }),
      );
      expect(result).toEqual({ jobId: 'bull_job_1', status: 'queued' });
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // IMPORT STATUS — tenant isolation
  // ═══════════════════════════════════════════════════════════════════
  describe('getImportStatus', () => {
    it('should throw when job not found', async () => {
      importQueue.getJob.mockResolvedValueOnce(null);

      await expect(service.getImportStatus('nonexistent')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw when job belongs to different tenant', async () => {
      importQueue.getJob.mockResolvedValueOnce({
        data: { tenantId: 'other_tenant', userId: 'user_1' },
        getState: jest.fn().mockResolvedValue('active'),
        progress: {},
        returnvalue: null,
        failedReason: null,
      });

      await expect(service.getImportStatus('job_other')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // STAGE TRANSITIONS — close stamps and the reopen guard
  // ═══════════════════════════════════════════════════════════════════
  describe('stage transitions', () => {
    const OPEN = 'stage_open';
    const WON = 'stage_won';
    const LOST = 'stage_lost';

    beforeEach(() => {
      stages = {
        [OPEN]: { _id: OPEN, name: 'Proposal', isWon: false, isLost: false },
        [WON]: { _id: WON, name: 'Closed Won', isWon: true, isLost: false },
        [LOST]: { _id: LOST, name: 'Closed Lost', isWon: false, isLost: true },
      };
    });

    const existing = (stageId: string, extra: Record<string, any> = {}) => {
      repository.findOne.mockResolvedValue({
        id: 'd1',
        title: 'Enterprise',
        stageId,
        ...extra,
      });
    };

    it('should stamp wonAt when a deal moves into a won stage', async () => {
      // `wonAt` is READ by the assignment workload projection, the record candidate
      // loader and the stale-deal trigger as the definition of "still open" — and nothing
      // wrote it, so a won deal stayed on its owner's workload forever.
      existing(OPEN);
      await service.update('d1', { stageId: WON } as any);

      const payload = repository.update.mock.calls[0][1];
      expect(payload.wonAt).toBeInstanceOf(Date);
      expect(payload.lostAt).toBeNull();
    });

    it('should stamp lostAt when a deal moves into a lost stage', async () => {
      existing(OPEN);
      await service.update('d1', { stageId: LOST } as any);

      const payload = repository.update.mock.calls[0][1];
      expect(payload.lostAt).toBeInstanceOf(Date);
      expect(payload.wonAt).toBeNull();
    });

    it('should NOT re-stamp a deal already carrying the timestamp', async () => {
      // Moving between two won stages must not move the close date.
      const original = new Date('2026-01-01T00:00:00.000Z');
      existing(LOST, { lostAt: original });
      stages.stage_lost_2 = {
        _id: 'stage_lost_2',
        name: 'Lost - No budget',
        isLost: true,
      };

      await service.update('d1', { stageId: 'stage_lost_2' } as any);

      expect(repository.update.mock.calls[0][1].lostAt).toBe(original);
    });

    it('should REFUSE to reopen a closed deal without allowReopen', async () => {
      // Reopening a won deal changes closed revenue in every report that reads it, so it
      // should be a deliberate act rather than a drag between two columns.
      existing(WON, { wonAt: new Date() });

      // Assert the CODE, not the exception class: DEAL_ALREADY_WON is what lets the
      // client show a localised message and offer "reopen anyway" (§42).
      await expect(
        service.update('d1', { stageId: OPEN } as any),
      ).rejects.toMatchObject({
        errorCode: DEAL_ERRORS.ALREADY_WON,
        status: HttpStatus.BAD_REQUEST,
      });
      expect(repository.update).not.toHaveBeenCalled();
    });

    it('should allow an explicit reopen and CLEAR both stamps', async () => {
      // Both, not just the one that was set: won → lost → open would otherwise keep the
      // older stamp and read as closed to the three systems that check them.
      existing(WON, { wonAt: new Date() });

      await service.update('d1', {
        stageId: OPEN,
        allowReopen: true,
      } as any);

      const payload = repository.update.mock.calls[0][1];
      expect(payload.wonAt).toBeNull();
      expect(payload.lostAt).toBeNull();
    });

    it('should ignore a stage change that is not one', async () => {
      existing(OPEN);
      await service.update('d1', { stageId: OPEN, value: 999 } as any);

      const payload = repository.update.mock.calls[0][1];
      expect(payload).not.toHaveProperty('wonAt');
      expect(payload).not.toHaveProperty('lostAt');
    });

    it('should leave a deal alone when the update does not touch the stage', async () => {
      existing(WON, { wonAt: new Date() });
      await service.update('d1', { value: 1234 } as any);

      expect(stageModel.findById).not.toHaveBeenCalled();
      expect(repository.update).toHaveBeenCalled();
    });

    it('should not block the first stage assignment', async () => {
      // Creation-ish path: no previous stage means no transition to guard.
      existing(undefined as any);
      await service.update('d1', { stageId: WON } as any);

      expect(repository.update.mock.calls[0][1].wonAt).toBeInstanceOf(Date);
    });

    it('should treat an unknown stage id as not closed rather than throwing', async () => {
      // A stage deleted from the pipeline after a deal was parked in it must not make the
      // deal uneditable — fail open on the LOOKUP, since the guard exists to protect
      // revenue reporting, not to police referential integrity.
      existing('stage_deleted');
      await service.update('d1', { stageId: OPEN } as any);

      expect(repository.update).toHaveBeenCalled();
    });
  });
});
