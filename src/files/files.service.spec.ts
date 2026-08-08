import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ClsService } from 'nestjs-cls';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { FilesService } from './files.service';
import { FileRepository } from './infrastructure/persistence/file.repository';
import { RedisService } from '../redis/redis.service';

describe('FilesService', () => {
  let service: FilesService;
  let fileRepo: jest.Mocked<Partial<FileRepository>>;

  const mockFile = {
    id: 'file-1',
    tenantId: 'tenant-1',
    fileName: 'contract.pdf',
    originalName: 'contract.pdf',
    mimeType: 'application/pdf',
    fileSize: 1024,
    path: 'tenant-1/contract.pdf',
    uploadedBy: 'user-1',
    accessLevel: 'private' as const,
    allowedUserIds: ['user-2'],
    status: 'ready' as const,
    category: 'documents',
    isDeleted: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    fileRepo = {
      findById: jest.fn(),
      softDelete: jest.fn(),
      hardDelete: jest.fn(),
      updateAccessLevel: jest.fn(),
      sumFileSizes: jest.fn(),
      getCategoryBreakdown: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FilesService,
        { provide: FileRepository, useValue: fileRepo },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockImplementation((key: string) => {
              if (key === 'file.awsDefaultS3Bucket') return 'test-bucket';
              if (key === 'file.awsS3Region') return 'us-east-1';
              return undefined;
            }),
          },
        },
        {
          provide: ClsService,
          useValue: { get: jest.fn().mockReturnValue('tenant-1') },
        },
        {
          provide: RedisService,
          useValue: { get: jest.fn(), set: jest.fn(), del: jest.fn().mockResolvedValue(1) },
        },
      ],
    }).compile();

    service = module.get<FilesService>(FilesService);
  });

  describe('findById', () => {
    it('should return file when tenant matches', async () => {
      (fileRepo.findById as jest.Mock).mockResolvedValue(mockFile);
      const result = await service.findById('file-1', 'tenant-1');
      expect(result).toEqual(mockFile);
    });

    it('should return null when tenant does not match (Isolation)', async () => {
      (fileRepo.findById as jest.Mock).mockResolvedValue(mockFile);
      const result = await service.findById('file-1', 'tenant-2');
      expect(result).toBeNull();
    });
  });

  describe('checkAccess', () => {
    it('should grant access to file uploader', () => {
      const hasAccess = service.checkAccess(mockFile as any, 'user-1', 'MEMBER', 'tenant-1');
      expect(hasAccess).toBe(true);
    });

    it('should grant access to allowed user IDs in private file', () => {
      const hasAccess = service.checkAccess(mockFile as any, 'user-2', 'MEMBER', 'tenant-1');
      expect(hasAccess).toBe(true);
    });

    it('should deny access to non-allowed user in private file', () => {
      const hasAccess = service.checkAccess(mockFile as any, 'user-3', 'MEMBER', 'tenant-1');
      expect(hasAccess).toBe(false);
    });

    it('should deny access if requestingTenantId does not match', () => {
      const hasAccess = service.checkAccess(mockFile as any, 'user-1', 'ADMIN', 'tenant-other');
      expect(hasAccess).toBe(false);
    });
  });
});
