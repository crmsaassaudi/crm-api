import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { FolderService } from './folder.service';
import { FolderDocumentRepository } from './infrastructure/persistence/document/repositories/folder.repository';
import { FileRepository } from './infrastructure/persistence/file.repository';

describe('FolderService', () => {
  let service: FolderService;
  let folderRepo: jest.Mocked<Partial<FolderDocumentRepository>>;
  let fileRepo: jest.Mocked<Partial<FileRepository>>;

  const mockFolder = {
    id: 'folder-1',
    tenantId: 'tenant-1',
    name: 'Sales Documents',
    parentId: null,
    path: '/folder-1',
    depth: 0,
    createdBy: 'user-1',
    color: '#3B82F6',
    isDeleted: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    folderRepo = {
      create: jest.fn(),
      findById: jest.fn(),
      findByParent: jest.fn(),
      findByTenant: jest.fn(),
      rename: jest.fn(),
      move: jest.fn(),
      updateColor: jest.fn(),
      updateDescendantPaths: jest.fn(),
      softDelete: jest.fn(),
      restore: jest.fn(),
      hardDelete: jest.fn(),
      existsByName: jest.fn(),
      findDescendants: jest.fn(),
      softDeleteDescendants: jest.fn(),
      restoreDescendants: jest.fn(),
      hardDeleteDescendants: jest.fn(),
    };

    fileRepo = {
      bulkSoftDeleteByFolderIds: jest.fn().mockResolvedValue(2),
      bulkRestoreByFolderIds: jest.fn().mockResolvedValue(2),
      bulkMoveToFolder: jest.fn().mockResolvedValue(2),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FolderService,
        { provide: FolderDocumentRepository, useValue: folderRepo },
        { provide: FileRepository, useValue: fileRepo },
      ],
    }).compile();

    service = module.get<FolderService>(FolderService);
  });

  describe('findById', () => {
    it('should return folder when tenant matches', async () => {
      (folderRepo.findById as jest.Mock).mockResolvedValue(mockFolder);
      const result = await service.findById('folder-1', 'tenant-1');
      expect(result).toEqual(mockFolder);
    });

    it('should return null when tenantId does not match (Multi-Tenant Isolation)', async () => {
      (folderRepo.findById as jest.Mock).mockResolvedValue(mockFolder);
      const result = await service.findById('folder-1', 'tenant-other');
      expect(result).toBeNull();
    });
  });

  describe('softDelete', () => {
    it('should cascade soft delete to descendants and files', async () => {
      (folderRepo.findById as jest.Mock).mockResolvedValue(mockFolder);
      (folderRepo.softDelete as jest.Mock).mockResolvedValue({ ...mockFolder, isDeleted: true });
      (folderRepo.findDescendants as jest.Mock).mockResolvedValue([
        { id: 'sub-folder-1', path: '/folder-1/sub-folder-1' },
      ]);
      (folderRepo.softDeleteDescendants as jest.Mock).mockResolvedValue(1);

      const result = await service.softDelete('tenant-1', 'folder-1', 'user-1', 'OWNER');

      expect(result.isDeleted).toBe(true);
      expect(folderRepo.softDeleteDescendants).toHaveBeenCalledWith('tenant-1', '/folder-1');
      expect(fileRepo.bulkSoftDeleteByFolderIds).toHaveBeenCalledWith('tenant-1', ['folder-1', 'sub-folder-1']);
    });
  });

  describe('hardDelete', () => {
    it('should reject non-OWNER users', async () => {
      await expect(
        service.hardDelete('tenant-1', 'folder-1', 'MEMBER'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should cascade hard delete and unbind contained files for OWNER', async () => {
      (folderRepo.findById as jest.Mock).mockResolvedValue(mockFolder);
      (folderRepo.findDescendants as jest.Mock).mockResolvedValue([]);
      (folderRepo.hardDelete as jest.Mock).mockResolvedValue(true);

      await service.hardDelete('tenant-1', 'folder-1', 'OWNER');

      expect(fileRepo.bulkMoveToFolder).toHaveBeenCalledWith(['folder-1'], null);
      expect(folderRepo.hardDelete).toHaveBeenCalledWith('folder-1');
    });
  });
});
