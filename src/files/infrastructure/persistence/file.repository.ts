import { NullableType } from '../../../utils/types/nullable.type';
import {
  FileType,
  FileCategory,
  FileAccessLevel,
  FileStatus,
} from '../../domain/file';

export interface PaginationOptions {
  page: number;
  limit: number;
}

export interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
}

export interface FileListFilters {
  category?: FileCategory;
  status?: FileStatus;
  mimeTypePrefix?: string; // e.g. 'image/' for image gallery
  search?: string; // fileName search
  uploadedBy?: string;
  folderId?: string | null; // null = root (unfiled), undefined = all
}

export abstract class FileRepository {
  abstract create(
    data: Omit<
      FileType,
      'id' | 'createdAt' | 'updatedAt' | 'version' | 'tenantId'
    >,
  ): Promise<FileType>;

  abstract findById(id: FileType['id']): Promise<NullableType<FileType>>;

  abstract findByIds(ids: FileType['id'][]): Promise<FileType[]>;

  // ── New methods for file management ───────────────────────────

  /** Find all files linked to a conversation (for file history) */
  abstract findByConversation(
    tenantId: string,
    conversationId: string,
    filters?: { mimeTypePrefix?: string },
    pagination?: PaginationOptions,
  ): Promise<PaginatedResult<FileType>>;

  /** List files for a tenant with ACL filtering */
  abstract findByTenant(
    tenantId: string,
    userId: string,
    userRole: string,
    filters?: FileListFilters,
    pagination?: PaginationOptions,
  ): Promise<PaginatedResult<FileType>>;

  /** Upsert by messageId — idempotent for omni_media dedup */
  abstract upsertByMessageId(
    tenantId: string,
    messageId: string,
    data: Partial<FileType>,
  ): Promise<{ file: FileType; isNew: boolean }>;

  /** Soft-delete a file */
  abstract softDelete(id: string): Promise<NullableType<FileType>>;

  /** Hard-delete a file (removes DB record entirely) */
  abstract hardDelete(id: string): Promise<boolean>;

  /** Update access level and allowed users */
  abstract updateAccessLevel(
    id: string,
    accessLevel: FileAccessLevel,
    allowedUserIds: string[],
  ): Promise<NullableType<FileType>>;

  /** Update file status */
  abstract updateStatus(
    id: string,
    status: FileStatus,
  ): Promise<NullableType<FileType>>;

  // ── Cloud Drive extensions ────────────────────────────────────

  /** Rename a file */
  abstract rename(id: string, newName: string): Promise<NullableType<FileType>>;

  /** Move file to a different folder */
  abstract moveToFolder(
    id: string,
    folderId: string | null,
  ): Promise<NullableType<FileType>>;

  /** Bulk move files to a folder */
  abstract bulkMoveToFolder(
    ids: string[],
    folderId: string | null,
  ): Promise<number>;

  /** Bulk soft-delete */
  abstract bulkSoftDelete(ids: string[]): Promise<number>;

  /** Restore a soft-deleted file */
  abstract restore(id: string): Promise<NullableType<FileType>>;

  /** List trashed files */
  abstract findTrashed(
    tenantId: string,
    pagination?: PaginationOptions,
  ): Promise<PaginatedResult<FileType>>;

  /** Get top N files by size */
  abstract findTopBySize(tenantId: string, limit?: number): Promise<FileType[]>;

  /** Count total non-deleted files */
  abstract countByTenant(tenantId: string): Promise<number>;

  /** Count files uploaded in date range */
  abstract countRecentUploads(tenantId: string, since: Date): Promise<number>;

  /** Sum total file sizes (bytes) for a tenant */
  abstract sumFileSizes(tenantId: string): Promise<number>;

  /** Get file count and total size grouped by category */
  abstract getCategoryBreakdown(
    tenantId: string,
  ): Promise<Record<string, { count: number; sizeBytes: number }>>;
}
