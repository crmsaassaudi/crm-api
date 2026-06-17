import {
  IsOptional,
  IsString,
  IsEnum,
  IsArray,
  IsNumber,
  Min,
  Max,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { FileAccessLevel, FileCategory } from '../domain/file';

// ── Upload DTO ──────────────────────────────────────────────────────
export class UploadFileDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsEnum(['general', 'omni_media', 'ticket_attachment'])
  category?: FileCategory;

  @ApiPropertyOptional()
  @IsOptional()
  @IsEnum(['private', 'tenant', 'public'])
  accessLevel?: FileAccessLevel;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  conversationId?: string;

  @ApiPropertyOptional({
    description: 'Target folder ID. Omit or null for root.',
  })
  @IsOptional()
  @IsString()
  folderId?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];
}

// ── List Query DTO ──────────────────────────────────────────────────
export class ListFilesQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsEnum(['general', 'omni_media', 'ticket_attachment'])
  category?: FileCategory;

  @ApiPropertyOptional({ description: 'MIME type prefix, e.g. "image/"' })
  @IsOptional()
  @IsString()
  type?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({
    description: 'Folder ID. "root" = root level, undefined = all.',
  })
  @IsOptional()
  @IsString()
  folderId?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(100)
  limit?: number;
}

// ── Update Access DTO ───────────────────────────────────────────────
export class UpdateFileAccessDto {
  @IsEnum(['private', 'tenant', 'public'])
  accessLevel: FileAccessLevel;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  allowedUserIds?: string[];
}

// ── Rename DTO ──────────────────────────────────────────────────────
export class RenameFileDto {
  @IsString()
  name: string;
}

// ── Move DTO ────────────────────────────────────────────────────────
export class MoveFileDto {
  @IsOptional()
  @IsString()
  folderId?: string | null;
}

// ── Bulk Move DTO ───────────────────────────────────────────────────
export class BulkMoveDto {
  @IsArray()
  @IsString({ each: true })
  fileIds: string[];

  @IsOptional()
  @IsString()
  folderId?: string | null;
}

// ── Bulk Delete DTO ─────────────────────────────────────────────────
export class BulkDeleteDto {
  @IsArray()
  @IsString({ each: true })
  fileIds: string[];
}
