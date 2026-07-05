import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { FolderDocumentRepository } from './infrastructure/persistence/document/repositories/folder.repository';
import { FolderType } from './domain/folder';
import { NullableType } from '../utils/types/nullable.type';

const MAX_DEPTH = 5;

@Injectable()
export class FolderService {
  private readonly logger = new Logger(FolderService.name);

  constructor(private readonly folderRepository: FolderDocumentRepository) {}

  // ── Create ────────────────────────────────────────────────────────

  async createFolder(
    tenantId: string,
    userId: string,
    name: string,
    parentId: string | null = null,
    color?: string,
  ): Promise<FolderType> {
    const trimmedName = name.trim();
    if (!trimmedName || trimmedName.length > 100) {
      throw new BadRequestException('Folder name must be 1-100 characters');
    }

    // Check duplicate name under same parent
    const exists = await this.folderRepository.existsByName(
      tenantId,
      parentId,
      trimmedName,
    );
    if (exists) {
      throw new BadRequestException(
        `A folder named "${trimmedName}" already exists in this location`,
      );
    }

    // Resolve parent
    let parentPath = '';
    let depth = 0;
    if (parentId) {
      const parent = await this.folderRepository.findById(parentId);
      if (!parent || parent.tenantId !== tenantId) {
        throw new NotFoundException('Parent folder not found');
      }
      if (parent.isDeleted) {
        throw new BadRequestException(
          'Cannot create folder inside a deleted folder',
        );
      }
      parentPath = parent.path;
      depth = parent.depth + 1;

      if (depth >= MAX_DEPTH) {
        throw new BadRequestException(
          `Maximum folder depth of ${MAX_DEPTH} exceeded`,
        );
      }
    }

    // Create with temporary path (will be updated after we get the ID)
    const folder = await this.folderRepository.create({
      tenantId,
      name: trimmedName,
      parentId,
      path: '__temp__', // will update below
      depth,
      createdBy: userId,
      color,
      isDeleted: false,
    });

    // Update path with actual ID
    const actualPath = parentPath
      ? `${parentPath}/${folder.id}`
      : `/${folder.id}`;
    const updated = await this.folderRepository.move(
      folder.id,
      parentId,
      actualPath,
      depth,
    );

    return updated ?? folder;
  }

  // ── Read ──────────────────────────────────────────────────────────

  async findById(id: string): Promise<NullableType<FolderType>> {
    return this.folderRepository.findById(id);
  }

  async listByParent(
    tenantId: string,
    parentId: string | null,
  ): Promise<FolderType[]> {
    return this.folderRepository.findByParent(tenantId, parentId);
  }

  async listAll(tenantId: string): Promise<FolderType[]> {
    return this.folderRepository.findByTenant(tenantId);
  }

  // ── Rename ────────────────────────────────────────────────────────

  async renameFolder(
    tenantId: string,
    folderId: string,
    userId: string,
    userRole: string,
    newName: string,
  ): Promise<FolderType> {
    const folder = await this.folderRepository.findById(folderId);
    if (!folder || folder.tenantId !== tenantId) {
      throw new NotFoundException('Folder not found');
    }

    this.assertCanManage(folder, userId, userRole);

    const trimmedName = newName.trim();
    if (!trimmedName || trimmedName.length > 100) {
      throw new BadRequestException('Folder name must be 1-100 characters');
    }

    const exists = await this.folderRepository.existsByName(
      tenantId,
      folder.parentId,
      trimmedName,
      folderId,
    );
    if (exists) {
      throw new BadRequestException(
        `A folder named "${trimmedName}" already exists in this location`,
      );
    }

    const updated = await this.folderRepository.rename(folderId, trimmedName);
    if (!updated) throw new NotFoundException('Folder not found');
    return updated;
  }

  // ── Move ──────────────────────────────────────────────────────────

  async moveFolder(
    tenantId: string,
    folderId: string,
    userId: string,
    userRole: string,
    newParentId: string | null,
  ): Promise<FolderType> {
    const folder = await this.folderRepository.findById(folderId);
    if (!folder || folder.tenantId !== tenantId) {
      throw new NotFoundException('Folder not found');
    }

    this.assertCanManage(folder, userId, userRole);

    // Can't move to itself
    if (newParentId === folderId) {
      throw new BadRequestException('Cannot move a folder into itself');
    }

    // Resolve new parent
    const { newParentPath, newDepth } = await this.resolveNewParent(
      tenantId,
      folder,
      newParentId,
    );

    // Check duplicate name under new parent
    const exists = await this.folderRepository.existsByName(
      tenantId,
      newParentId,
      folder.name,
      folderId,
    );
    if (exists) {
      throw new BadRequestException(
        `A folder named "${folder.name}" already exists in the target location`,
      );
    }

    const oldPath = folder.path;
    const newPath = newParentPath
      ? `${newParentPath}/${folder.id}`
      : `/${folder.id}`;
    const depthDelta = newDepth - folder.depth;

    // Update this folder
    const updated = await this.folderRepository.move(
      folderId,
      newParentId,
      newPath,
      newDepth,
    );
    if (!updated) throw new NotFoundException('Folder not found');

    // Update descendants
    if (depthDelta !== 0 || oldPath !== newPath) {
      await this.folderRepository.updateDescendantPaths(
        tenantId,
        oldPath,
        newPath,
        depthDelta,
      );
    }

    return updated;
  }

  /** Resolve path and depth for the new parent folder, enforcing depth limits. */
  private async resolveNewParent(
    tenantId: string,
    folder: FolderType,
    newParentId: string | null,
  ): Promise<{ newParentPath: string; newDepth: number }> {
    if (!newParentId) {
      return { newParentPath: '', newDepth: 0 };
    }
    const newParent = await this.folderRepository.findById(newParentId);
    if (!newParent || newParent.tenantId !== tenantId) {
      throw new NotFoundException('Target folder not found');
    }
    // Can't move into a descendant
    if (newParent.path.startsWith(folder.path + '/')) {
      throw new BadRequestException(
        'Cannot move a folder into one of its descendants',
      );
    }
    const newDepth = newParent.depth + 1;
    if (newDepth >= MAX_DEPTH) {
      throw new BadRequestException(
        `Maximum folder depth of ${MAX_DEPTH} exceeded`,
      );
    }
    return { newParentPath: newParent.path, newDepth };
  }

  // ── Update Color ──────────────────────────────────────────────────

  async updateColor(
    tenantId: string,
    folderId: string,
    userId: string,
    userRole: string,
    color: string,
  ): Promise<FolderType> {
    const folder = await this.folderRepository.findById(folderId);
    if (!folder || folder.tenantId !== tenantId) {
      throw new NotFoundException('Folder not found');
    }
    this.assertCanManage(folder, userId, userRole);

    const updated = await this.folderRepository.updateColor(folderId, color);
    if (!updated) throw new NotFoundException('Folder not found');
    return updated;
  }

  // ── Delete ────────────────────────────────────────────────────────

  async softDelete(
    tenantId: string,
    folderId: string,
    userId: string,
    userRole: string,
  ): Promise<FolderType> {
    const folder = await this.folderRepository.findById(folderId);
    if (!folder || folder.tenantId !== tenantId) {
      throw new NotFoundException('Folder not found');
    }
    this.assertCanManage(folder, userId, userRole);

    const deleted = await this.folderRepository.softDelete(folderId);
    if (!deleted) throw new NotFoundException('Folder not found');

    this.logger.log(`Folder soft-deleted: ${folderId} by user ${userId}`);
    return deleted;
  }

  async restore(
    tenantId: string,
    folderId: string,
    userId: string,
    userRole: string,
  ): Promise<FolderType> {
    const folder = await this.folderRepository.findById(folderId);
    if (!folder || folder.tenantId !== tenantId) {
      throw new NotFoundException('Folder not found');
    }
    this.assertCanManage(folder, userId, userRole);

    const restored = await this.folderRepository.restore(folderId);
    if (!restored) throw new NotFoundException('Folder not found');
    return restored;
  }

  async hardDelete(
    tenantId: string,
    folderId: string,
    userRole: string,
  ): Promise<void> {
    if (!['OWNER'].includes(userRole?.toUpperCase())) {
      throw new ForbiddenException('Only OWNER can permanently delete folders');
    }

    const folder = await this.folderRepository.findById(folderId);
    if (!folder || folder.tenantId !== tenantId) {
      throw new NotFoundException('Folder not found');
    }

    await this.folderRepository.hardDelete(folderId);
    this.logger.log(`Folder hard-deleted: ${folderId}`);
  }

  // ── Permission helper ─────────────────────────────────────────────

  private assertCanManage(
    folder: FolderType,
    userId: string,
    userRole: string,
  ): void {
    const isAdmin = ['OWNER', 'ADMIN'].includes(userRole?.toUpperCase());
    if (!isAdmin && folder.createdBy !== userId) {
      throw new ForbiddenException(
        'Only the folder creator or admin can manage this folder',
      );
    }
  }
}
