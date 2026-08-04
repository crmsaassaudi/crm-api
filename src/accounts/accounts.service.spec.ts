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
      findIdentityCandidates: jest.fn(() => Promise.resolve([])),
      create: jest
        .fn()
        .mockImplementation((data) =>
          Promise.resolve({ id: 'acc_new', ...data }),
        ),
      findOne: jest.fn().mockResolvedValue(null),
      findManyWithPagination: jest
        .fn()
        .mockResolvedValue({ data: [], hasNextPage: false }),
      findManyWithCursorPagination: jest
        .fn()
        .mockResolvedValue({ data: [], nextCursor: null }),
      update: jest
        .fn()
        .mockImplementation((id, data) => Promise.resolve({ id, ...data })),
      remove: jest.fn().mockResolvedValue(undefined),
      restore: jest.fn().mockResolvedValue(null),
      findDeleted: jest.fn().mockResolvedValue({ data: [], total: 0 }),
    };

    entityAudit = { emit: jest.fn() };
    cls = createClsMock();

    importStorage = {
      storeImportFile: jest
        .fn()
        .mockResolvedValue({ fileKey: 'accounts/test.csv' }),
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
      // customFieldValidator: pass-through; its own behaviour is covered in its spec.
      {
        validate: jest.fn((_m: string, v: any) => Promise.resolve(v)),
      } as any,
      entityAudit,
      cls as any,
      {
        runWithEvent: jest.fn((mutate: any) => mutate(undefined)),
      } as any,
      storageFactory as any,
      importQueue,
      exportQueue as any,
      importJobModel,
      exportRequest,
      { validateTagIds: jest.fn().mockResolvedValue(undefined) } as any, // tagsService
      { emit: jest.fn() } as any, // eventEmitter
    );
  });

  // CRUD — audit trail
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
        undefined,
      );
    });

    it('should default phones and emails to empty arrays', async () => {
      await service.create({ name: 'Corp' } as any);

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({ phones: [], emails: [] }),
        undefined,
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

    it('should refuse an update whose pre-read finds nothing, and emit no audit', async () => {
      // See the matching test in deals.service.spec.ts: a scope miss is an
      // authorization outcome, not a silent no-op reported as success.
      repository.findOne.mockResolvedValueOnce(null);

      await expect(
        service.update('nonexistent', { name: 'X' } as any),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(repository.update).not.toHaveBeenCalled();
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

  // PAGINATION — cursor vs offset routing
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

  // IMPORT UPLOAD — validation
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

  // IMPORT START — mapping validation
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

  // IMPORT STATUS — tenant isolation
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
  // DUPLICATE DETECTION (company identity)
  describe('checkDuplicate', () => {
    const candidate = (over: Record<string, unknown>) => ({
      id: 'a1',
      name: 'Acme Corp',
      website: 'https://acme.com',
      taxId: '01-2345678',
      ...over,
    });

    it('should not query when the payload carries no identity at all', async () => {
      // Otherwise every blank lookup matches every blank account.
      const result = await service.checkDuplicate({});
      expect(result).toEqual({ isDuplicate: false, duplicates: [] });
      expect(repository.findIdentityCandidates).not.toHaveBeenCalled();
    });

    it('should report a shared tax id as EXACT even when the names differ', async () => {
      repository.findIdentityCandidates.mockResolvedValue([
        candidate({ name: 'Totally Different Ltd' }),
      ]);

      const result = await service.checkDuplicate({ taxId: '012345678' });

      expect(result.isDuplicate).toBe(true);
      expect(result.duplicates[0]).toMatchObject({
        confidence: 'exact',
        matchedOn: 'taxId',
      });
    });

    it('should report a shared domain as STRONG, not exact', async () => {
      repository.findIdentityCandidates.mockResolvedValue([
        candidate({ name: 'Acme EU', taxId: undefined }),
      ]);

      const result = await service.checkDuplicate({
        name: 'Acme US',
        website: 'www.acme.com/eu',
      });

      expect(result.duplicates[0]).toMatchObject({
        confidence: 'strong',
        matchedOn: 'website',
      });
    });

    it('should report a name-only match as WEAK', async () => {
      // "Acme Ltd" and "Acme GmbH" reduce to the same key and are different legal
      // entities, so this must never present as certainty.
      repository.findIdentityCandidates.mockResolvedValue([
        candidate({ name: 'Acme GmbH', website: undefined, taxId: undefined }),
      ]);

      const result = await service.checkDuplicate({ name: 'Acme Ltd' });

      expect(result.duplicates[0]).toMatchObject({
        confidence: 'weak',
        matchedOn: 'name',
      });
    });

    it('should rank the strongest evidence first', async () => {
      repository.findIdentityCandidates.mockResolvedValue([
        candidate({
          id: 'weak',
          name: 'Acme Ltd',
          website: undefined,
          taxId: undefined,
        }),
        candidate({ id: 'exact', name: 'Other', taxId: '012345678' }),
      ]);

      const result = await service.checkDuplicate({
        name: 'Acme Corp',
        taxId: '01-2345678',
      });

      expect(result.duplicates[0].id).toBe('exact');
    });

    it('should drop candidates that match on nothing', async () => {
      // The repository `$or`s across three keys, so a row can come back having matched
      // a key the comparison then rejects.
      repository.findIdentityCandidates.mockResolvedValue([
        candidate({ name: 'Globex', website: 'globex.com', taxId: '999' }),
      ]);

      const result = await service.checkDuplicate({
        name: 'Acme',
        website: 'acme.com',
      });

      expect(result).toEqual({ isDuplicate: false, duplicates: [] });
    });

    it('should pass excludeId through so editing a record does not match itself', async () => {
      await service.checkDuplicate({ name: 'Acme', excludeId: 'a1' });
      expect(repository.findIdentityCandidates).toHaveBeenCalledWith(
        expect.any(Object),
        'a1',
      );
    });
  });

  describe('recycle bin', () => {
    it('should clamp the page size so a caller cannot ask for the whole bin', async () => {
      await service.listDeleted({ page: 3, limit: 5000 });
      expect(repository.findDeleted).toHaveBeenCalledWith({
        page: 3,
        limit: 100,
      });
    });

    it('should default to page 1 and reject a zero or negative page', async () => {
      await service.listDeleted({ page: 0 });
      expect(repository.findDeleted).toHaveBeenCalledWith({
        page: 1,
        limit: 25,
      });
    });

    it('should restore an archived account and audit the resurrection', async () => {
      repository.restore.mockResolvedValue({ id: 'acc_1', name: 'Acme' });

      const restored = await service.restore('acc_1');

      expect(restored).toEqual({ id: 'acc_1', name: 'Acme' });
      // The audit trail has to show a record coming BACK, not just going away —
      // otherwise a restored record looks like it was never deleted.
      expect(entityAudit.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          entityType: 'ACCOUNT',
          entityId: 'acc_1',
          oldSnapshot: { _deleted: true },
        }),
      );
    });

    it('should 404 rather than pretend to restore a purged account', async () => {
      // `restore()` returns null both for "never existed" and "already purged". A
      // silent success here would tell someone their data is back when it is gone.
      repository.restore.mockResolvedValue(null);

      await expect(service.restore('acc_gone')).rejects.toThrow(
        NotFoundException,
      );
      expect(entityAudit.emit).not.toHaveBeenCalled();
    });
  });
});
