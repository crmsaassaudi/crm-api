import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ContactExportStorageService } from './contact-export-storage.service';

describe('ContactExportStorageService import ownership', () => {
  const service = new ContactExportStorageService(
    { get: jest.fn(() => undefined) } as any,
    { get: jest.fn(() => undefined) } as any,
  );
  const ownedKey =
    'imports/contacts/tenant-1.user-1.01JTEST-contact-import.csv';

  it('should accept an import key bound to the tenant and uploader', () => {
    expect(() =>
      service.assertImportFileOwned(ownedKey, 'tenant-1', 'user-1'),
    ).not.toThrow();
  });

  it.each([
    ['tenant-2', 'user-1'],
    ['tenant-1', 'user-2'],
  ])('should hide a key owned by another principal', (tenantId, userId) => {
    expect(() =>
      service.assertImportFileOwned(ownedKey, tenantId, userId),
    ).toThrow(NotFoundException);
  });

  it('should reject traversal before evaluating ownership', () => {
    expect(() =>
      service.assertImportFileOwned(
        'imports/contacts/../tenant-1.user-1.file.csv',
        'tenant-1',
        'user-1',
      ),
    ).toThrow(NotFoundException);
  });

  it('should fail closed when an owned export is read without user context', async () => {
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
});
