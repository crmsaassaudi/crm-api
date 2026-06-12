import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AccountsService } from './accounts.service';
import { createClsMock } from '../test/mocks/cls.mock';

/**
 * AccountsService — Phase 3 unit tests
 *
 * Covers: CRUD with entity audit, ownerId sanitization,
 * import validation (name required, valid fields, dedup field presence),
 * import status tenant isolation, cursor vs offset pagination routing.
 */
describe('AccountsService', () => {
  let service: AccountsService;
  let repository: any;
  let entityAudit: any;
  let cls: ReturnType<typeof createClsMock>;
  let importStorage: any;
  let importQueue: any;
  let exportQueue: any;
  let importJobModel: any;
  let exportRequest: any;

  beforeEach(() => {
    repository = {
      create: jest.fn().mockImplementation((data) =>
        Promise.resolve({ id: 'acc_new', ...data }),
      ),
      findOne: jest.fn().mockResolvedValue(null),
      findManyWithPagination: jest.fn().mockResolvedValue({ data: [], hasNextPage: false }),
      findManyWithCursorPagination: jest.fn().mockResolvedValue({ data: [], nextCursor: null }),
      update: jest.fn().mockImplementation((id, data) =>
        Promise.resolve({ id, ...data }),
      ),
      remove: jest.fn().mockResolvedValue(undefined),
    };

    entityAudit = { emit: jest.fn() };
    cls = createClsMock();

    importStorage = {
      storeImportFile: jest.fn().mockResolvedValue({ fileKey: 'accounts/test.csv' }),
      importFileExists: jest.fn().mockResolvedValue(true),
    };

    const storageFactory = {
      create: jest.fn().mockReturnValue(importStorage),
    };

    importQueue = {
      add: jest.fn().mockResolvedValue({ id: 'bull_acc_1' }),
      getJob: jest.fn().mockResolvedValue(null),
    };
    exportQueue = {};

    importJobModel = {
      create: jest.fn().mockResolvedValue({}),
      find: jest.fn().mockReturnValue({
        sort: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        populate: jest.fn().mockReturnThis(),
        lean: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([]),
      }),
      countDocuments: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue(0),
      }),
      findOne: jest.fn().mockReturnValue({
        lean: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue(null),
      }),
    };

    exportRequest = {
      enqueue: jest.fn(),
      status: jest.fn(),
      cancel: jest.fn(),
      list: jest.fn(),
      download: jest.fn(),
    };

    service = new AccountsService(
      repository,
      entityAudit,
      cls as any,
      storageFactory as any,
      importQueue,
      exportQueue as any,
      importJobModel,
      exportRequest,
    );
  });

  // ═══════════════════════════════════════════════════════════════════
  // CRUD — audit trail
  // ═══════════════════════════════════════════════════════════════════
  describe('create', () => {
    it('should create account and emit audit event', async () => {
      const result = await service.create({
        name: 'Acme Corp',
        industry: 'Tech',
      } as any);

      expect(repository.create).toHaveBeenCalled();
      expect(entityAudit.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          entity: 'account',
          entityType: 'ACCOUNT',
          kind: 'created',
        }),
      );
      expect(result.id).toBe('acc_new');
    });

    it('should sanitize empty ownerId to undefined', async () => {
      await service.create({ name: 'Corp', ownerId: '' } as any);

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ ownerId: undefined }),
      );
    });

    it('should default phones and emails to empty arrays', async () => {
      await service.create({ name: 'Corp' } as any);

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ phones: [], emails: [] }),
      );
    });
  });

  describe('update', () => {
    it('should emit audit with old and new snapshots', async () => {
      const existing = { id: 'acc_1', name: 'Old Corp' };
      repository.findOne.mockResolvedValueOnce(existing);

      await service.update('acc_1', { name: 'New Corp' } as any);

      expect(entityAudit.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'updated',
          oldSnapshot: existing,
          newSnapshot: expect.objectContaining({ id: 'acc_1' }),
        }),
      );
    });

    it('should NOT emit audit when update returns null', async () => {
      repository.update.mockResolvedValueOnce(null);

      await service.update('nonexistent', { name: 'X' } as any);

      expect(entityAudit.emit).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('should emit audit with _deleted flag', async () => {
      repository.findOne.mockResolvedValueOnce({ id: 'acc_1', name: 'Gone' });

      await service.remove('acc_1');

      expect(repository.remove).toHaveBeenCalledWith('acc_1');
      expect(entityAudit.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          entityId: 'acc_1',
          newSnapshot: expect.objectContaining({ _deleted: true }),
        }),
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // PAGINATION — cursor vs offset routing
  // ═══════════════════════════════════════════════════════════════════
  describe('findAll', () => {
    it('should use cursor pagination when cursor is present', async () => {
      await service.findAll({ cursor: 'abc123', limit: 20 });

      expect(repository.findManyWithCursorPagination).toHaveBeenCalled();
      expect(repository.findManyWithPagination).not.toHaveBeenCalled();
    });

    it('should use offset pagination by default', async () => {
      await service.findAll({ page: 2, limit: 10 });

      expect(repository.findManyWithPagination).toHaveBeenCalled();
      expect(repository.findManyWithCursorPagination).not.toHaveBeenCalled();
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // IMPORT UPLOAD — validation
  // ═══════════════════════════════════════════════════════════════════
  describe('uploadImportFile', () => {
    it('should throw when no file', async () => {
      await expect(service.uploadImportFile(null as any)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw when file exceeds limit', async () => {
      await expect(
        service.uploadImportFile({
          buffer: Buffer.alloc(100 * 1024 * 1024),
          originalname: 'big.csv',
          size: 100 * 1024 * 1024,
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // IMPORT START — mapping validation
  // ═══════════════════════════════════════════════════════════════════
  describe('startImport', () => {
    it('should throw when mapping is missing required name field', async () => {
      await expect(
        service.startImport({
          fileKey: 'accounts/test.csv',
          mapping: { col1: 'industry' },
        } as any),
      ).rejects.toThrow('mapping must include name');
    });

    it('should throw when mapping contains invalid fields', async () => {
      await expect(
        service.startImport({
          fileKey: 'accounts/test.csv',
          mapping: { col1: 'name', col2: 'NOT_A_REAL_FIELD' },
        } as any),
      ).rejects.toThrow(/Invalid mapping target/);
    });

    it('should throw when dedup field is not in mapping', async () => {
      await expect(
        service.startImport({
          fileKey: 'accounts/test.csv',
          mapping: { col1: 'name' },
          deduplication: {
            matchingFields: ['emails'], // emails not in mapping
          },
        } as any),
      ).rejects.toThrow(/not present in the column mapping/);
    });

    it('should throw when file key is expired', async () => {
      importStorage.importFileExists.mockResolvedValueOnce(false);

      await expect(
        service.startImport({
          fileKey: 'accounts/expired.csv',
          mapping: { col1: 'name' },
        } as any),
      ).rejects.toThrow('fileKey not found in storage');
    });

    it('should enqueue import job with correct tenant context', async () => {
      const result = await service.startImport({
        fileKey: 'accounts/test.csv',
        mapping: { col1: 'name' },
      } as any);

      expect(importQueue.add).toHaveBeenCalledWith(
        'import',
        expect.objectContaining({
          tenantId: 'tenant_1',
          fileKey: 'accounts/test.csv',
        }),
      );
      expect(result.status).toBe('queued');
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // IMPORT STATUS — tenant isolation
  // ═══════════════════════════════════════════════════════════════════
  describe('getImportStatus', () => {
    it('should throw NotFoundException when job does not exist', async () => {
      await expect(service.getImportStatus('no_job')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw when job belongs to different tenant', async () => {
      importQueue.getJob.mockResolvedValueOnce({
        data: { tenantId: 'other_tenant', userId: 'user_1' },
        getState: jest.fn().mockResolvedValue('completed'),
        progress: {},
        returnvalue: null,
        failedReason: null,
      });

      await expect(service.getImportStatus('cross_tenant_job')).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
