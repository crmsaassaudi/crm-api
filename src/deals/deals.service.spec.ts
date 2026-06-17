import { BadRequestException, NotFoundException } from '@nestjs/common';
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
      cls as any,
      eventEmitter as any,
      entityAudit,
      storageFactory as any,
      importQueue,
      exportQueue,
      importJobModel,
      exportRequest,
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
      );
      expect(result.id).toBe('deal_new');
    });

    it('should sanitize empty ownerId to undefined', async () => {
      await service.create({ title: 'Deal', ownerId: '' } as any);

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ ownerId: undefined }),
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
});
