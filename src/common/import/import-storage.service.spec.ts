import { ForbiddenException } from '@nestjs/common';
import { ImportStorageService } from './import-storage.service';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

describe('ImportStorageService report ownership', () => {
  it('should fail closed when request user context is missing', async () => {
    const service = new ImportStorageService(
      'contacts',
      { get: jest.fn(() => undefined) } as any,
      { get: jest.fn(() => undefined) } as any,
    );
    const token = '01JTESTREPORTTOKEN00000000';
    (service as any).localReportTokens.set(token, {
      filePath: 'not-read-when-forbidden',
      filename: 'import-report.json',
      expiresAt: new Date(Date.now() + 60_000),
      ownerId: 'user-1',
    });

    await expect(service.readLocalReport(token)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('should reject an import file owned by another tenant', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'import-owner-test-'));
    const path = join(directory, 'file.csv');
    await writeFile(path, 'subject\nhello');
    await writeFile(
      `${path}.meta.json`,
      JSON.stringify({ ownerId: 'user-1', tenantId: 'tenant-1' }),
    );
    const service = new ImportStorageService(
      'tickets',
      { get: jest.fn(() => undefined) } as any,
      { get: jest.fn(() => undefined) } as any,
    );
    jest.spyOn(service as any, 'localPathForKey').mockReturnValue(path);

    try {
      await expect(
        service.assertImportFileOwnership(
          'imports/tickets/01J00000000000000000000000-file.csv',
          'tenant-2',
          'user-1',
        ),
      ).rejects.toThrow(ForbiddenException);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('should accept an import file owned by the active tenant and user', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'import-owner-test-'));
    const path = join(directory, 'file.csv');
    await writeFile(path, 'subject\nhello');
    await writeFile(
      `${path}.meta.json`,
      JSON.stringify({ ownerId: 'user-1', tenantId: 'tenant-1' }),
    );
    const service = new ImportStorageService(
      'tickets',
      { get: jest.fn(() => undefined) } as any,
      { get: jest.fn(() => undefined) } as any,
    );
    jest.spyOn(service as any, 'localPathForKey').mockReturnValue(path);

    try {
      await expect(
        service.assertImportFileOwnership(
          'imports/tickets/01J00000000000000000000000-file.csv',
          'tenant-1',
          'user-1',
        ),
      ).resolves.toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('should reject a storage key from another entity namespace', async () => {
    const service = new ImportStorageService(
      'tickets',
      { get: jest.fn(() => undefined) } as any,
      { get: jest.fn(() => undefined) } as any,
    );
    await expect(
      service.assertImportFileOwnership(
        'imports/contacts/01J00000000000000000000000-file.csv',
        'tenant-1',
        'user-1',
      ),
    ).rejects.toThrow('Import file not found');
  });

  it('should open an owned report as a bounded-memory file stream', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'report-stream-test-'));
    const path = join(directory, 'report.json');
    await writeFile(path, '{"errors":[]}');
    const service = new ImportStorageService(
      'contacts',
      { get: jest.fn(() => undefined) } as any,
      {
        get: jest.fn((key: string) =>
          key === 'userId' ? 'user-1' : undefined,
        ),
      } as any,
    );
    (service as any).localReportTokens.set('token', {
      filePath: path,
      filename: 'report.json',
      expiresAt: new Date(Date.now() + 60_000),
      ownerId: 'user-1',
    });

    try {
      const opened = await service.openLocalReport('token');
      expect(opened).toEqual(
        expect.objectContaining({ filename: 'report.json', size: 13 }),
      );
      expect(opened).not.toHaveProperty('buffer');
      opened.stream.destroy();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
