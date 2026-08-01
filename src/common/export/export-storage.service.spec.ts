import { ForbiddenException } from '@nestjs/common';
import { ExportStorageService } from './export-storage.service';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

describe('ExportStorageService ownership', () => {
  it('should fail closed when request user context is missing', async () => {
    const service = new ExportStorageService(
      'contacts',
      { get: jest.fn(() => undefined) } as any,
      { get: jest.fn(() => undefined) } as any,
    );
    const token = '01JTESTEXPORTTOKEN00000000';
    (service as any).localTokens.set(token, {
      filePath: 'not-read-when-forbidden',
      filename: 'contacts.csv',
      expiresAt: new Date(Date.now() + 60_000),
      ownerId: 'user-1',
    });

    await expect(service.readLocalExport(token)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('should open an owned export as a bounded-memory file stream', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'export-stream-test-'));
    const path = join(directory, 'contacts.csv');
    await writeFile(path, 'firstName,lastName\nAlice,Smith\n');
    const service = new ExportStorageService(
      'contacts',
      { get: jest.fn(() => undefined) } as any,
      {
        get: jest.fn((key: string) =>
          key === 'userId' ? 'user-1' : undefined,
        ),
      } as any,
    );
    (service as any).localTokens.set('token', {
      filePath: path,
      filename: 'contacts.csv',
      expiresAt: new Date(Date.now() + 60_000),
      ownerId: 'user-1',
    });

    try {
      const opened = await service.openLocalExport('token');
      expect(opened).toEqual(
        expect.objectContaining({ filename: 'contacts.csv', size: 31 }),
      );
      expect(opened).not.toHaveProperty('buffer');
      opened.stream.destroy();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
