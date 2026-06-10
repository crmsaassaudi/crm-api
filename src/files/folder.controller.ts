import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { IsString, IsOptional, MinLength } from 'class-validator';
import { ClsService } from 'nestjs-cls';
import { FolderService } from './folder.service';
import { RequirePermission } from '../common/permissions';

// ── DTOs ──────────────────────────────────────────────────────────

class CreateFolderDto {
  @IsString()
  @MinLength(1)
  name: string;

  @IsString()
  @IsOptional()
  parentId?: string | null;

  @IsString()
  @IsOptional()
  color?: string;
}

class UpdateFolderDto {
  @IsString()
  @MinLength(1)
  @IsOptional()
  name?: string;

  @IsString()
  @IsOptional()
  parentId?: string | null;

  @IsString()
  @IsOptional()
  color?: string;
}

/**
 * Folder Management REST API.
 *
 * Endpoints:
 *   POST   /folders             — create a folder
 *   GET    /folders             — list all folders (flat tree)
 *   GET    /folders/:id         — folder detail
 *   PATCH  /folders/:id         — rename / move / change color
 *   DELETE /folders/:id         — soft delete
 *   POST   /folders/:id/restore — restore from trash
 *   DELETE /folders/:id/purge   — hard delete (OWNER only)
 */
@Controller({ path: 'folders', version: '1' })
export class FolderController {
  constructor(
    private readonly folderService: FolderService,
    private readonly cls: ClsService,
  ) {}

  // ── Create ────────────────────────────────────────────────────────

  @Post()
  @RequirePermission('edit', 'files')
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() dto: CreateFolderDto) {
    const tenantId = this.cls.get<string>('tenantId');
    const userId = this.cls.get<string>('userId');

    return this.folderService.createFolder(
      tenantId,
      userId,
      dto.name,
      dto.parentId ?? null,
      dto.color,
    );
  }

  // ── List all (flat for client-side tree assembly) ──────────────────

  @Get()
  @RequirePermission('view', 'files')
  async listAll() {
    const tenantId = this.cls.get<string>('tenantId');
    return this.folderService.listAll(tenantId);
  }

  // ── Detail ────────────────────────────────────────────────────────

  @Get(':id')
  @RequirePermission('view', 'files')
  async findById(@Param('id') id: string) {
    return this.folderService.findById(id);
  }

  // ── Update (rename, move, change color) ───────────────────────────

  @Patch(':id')
  @RequirePermission('edit', 'files')
  @HttpCode(HttpStatus.OK)
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateFolderDto,
  ) {
    const tenantId = this.cls.get<string>('tenantId');
    const userId = this.cls.get<string>('userId');
    const userRole = this.cls.get<string>('tenantRole') ?? '';

    let result = null;

    // Handle rename
    if (dto.name !== undefined) {
      result = await this.folderService.renameFolder(
        tenantId,
        id,
        userId,
        userRole,
        dto.name,
      );
    }

    // Handle move
    if (dto.parentId !== undefined) {
      result = await this.folderService.moveFolder(
        tenantId,
        id,
        userId,
        userRole,
        dto.parentId,
      );
    }

    // Handle color change
    if (dto.color !== undefined) {
      result = await this.folderService.updateColor(
        tenantId,
        id,
        userId,
        userRole,
        dto.color,
      );
    }

    return result;
  }

  // ── Soft Delete ───────────────────────────────────────────────────

  @Delete(':id')
  @RequirePermission('edit', 'files')
  @HttpCode(HttpStatus.OK)
  async softDelete(@Param('id') id: string) {
    const tenantId = this.cls.get<string>('tenantId');
    const userId = this.cls.get<string>('userId');
    const userRole = this.cls.get<string>('tenantRole') ?? '';

    return this.folderService.softDelete(tenantId, id, userId, userRole);
  }

  // ── Restore ───────────────────────────────────────────────────────

  @Post(':id/restore')
  @RequirePermission('edit', 'files')
  @HttpCode(HttpStatus.OK)
  async restore(@Param('id') id: string) {
    const tenantId = this.cls.get<string>('tenantId');
    const userId = this.cls.get<string>('userId');
    const userRole = this.cls.get<string>('tenantRole') ?? '';

    return this.folderService.restore(tenantId, id, userId, userRole);
  }

  // ── Hard Delete (OWNER only) ──────────────────────────────────────

  @Delete(':id/purge')
  @HttpCode(HttpStatus.OK)
  async hardDelete(@Param('id') id: string) {
    const tenantId = this.cls.get<string>('tenantId');
    const userRole = this.cls.get<string>('tenantRole') ?? '';

    await this.folderService.hardDelete(tenantId, id, userRole);
    return { deleted: true };
  }
}
