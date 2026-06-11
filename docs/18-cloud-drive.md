# 18 — Cloud Drive & File Management

> **Source:** `src/files/`  
> **Controllers:** `FileManagementController`, `FolderController`  
> **Services:** `FilesService`, `FolderService`, `ImageProcessingService`  
> **Permissions:** `files:view`, `files:create`, `files:edit`, `files:delete`, `storage:view`

---

## Overview

The Cloud Drive module provides a **Google-Drive-style file management system** within the CRM. It enables tenants to upload, organize, search, and share files across the platform. Files are stored in **Amazon S3** (or S3-compatible services like DigitalOcean Spaces) and organized into **virtual folders** tracked purely in MongoDB — no S3 key renaming is needed when moving or reorganizing files.

### Key Capabilities

| Feature | Description |
|---|---|
| **File Upload** | Multipart upload with automatic image compression and thumbnail generation |
| **Folder Hierarchy** | Nested folders up to 5 levels deep with materialized path pattern |
| **ACL (Access Control)** | Three-tier access: `private`, `tenant`, `public` |
| **Image Processing** | Auto-compress to WebP, resize to 2048px max, platform-specific compression |
| **Thumbnail Generation** | Auto-generate 200×200 WebP thumbnails for image files |
| **Storage Quota** | Per-tenant storage quotas with atomic increment/decrement |
| **Soft Delete + Trash** | 30-day trash with restore capability; OWNER hard-delete |
| **Bulk Operations** | Bulk move and bulk delete for multi-file workflows |
| **File Security** | Extension allowlist, MIME type validation, magic byte detection |
| **Deduplication** | SHA-256 checksum indexing for content-level dedup |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                   Cloud Drive Frontend                          │
│  CloudDrivePage → useDriveStore (Zustand) → driveService (API)  │
│  Components: FolderTree, FileGrid, FileList, UploadZone,        │
│             FileDetailPanel, MoveToDialog, RenameDialog         │
└──────────────────────────┬──────────────────────────────────────┘
                           │ REST /api/v1
        ┌──────────────────▼──────────────────────┐
        │          FileManagementController        │
        │   POST /files/upload                     │
        │   GET  /files    GET /files/:id          │
        │   PATCH /files/:id/rename|move|access    │
        │   DELETE /files/:id                      │
        │   GET  /files/storage/usage              │
        ├──────────────────────────────────────────│
        │          FolderController                │
        │   POST /folders   GET /folders           │
        │   PATCH /folders/:id                     │
        │   DELETE /folders/:id                    │
        └─────┬──────────┬──────────┬──────────────┘
              │          │          │
     ┌────────▼───┐ ┌────▼────┐ ┌──▼──────────────┐
     │ FilesService│ │ Folder  │ │ ImageProcessing │
     │            │ │ Service │ │    Service       │
     └─────┬──────┘ └────┬────┘ │  (sharp/libvips)│
           │              │      └─────────────────┘
     ┌─────▼──────────────▼─────────┐
     │     MongoDB (files, folders)  │
     │  + S3 (binary object storage) │
     └──────────────────────────────┘
```

### Storage Model

Files use a **flat S3 key** strategy (`{tenantId}/{randomHash}.{ext}`), while folders are **virtual containers** tracked only in MongoDB. This eliminates the need for expensive S3 rename/move operations when reorganizing files.

| Aspect | Implementation |
|---|---|
| S3 Key Format | `{tenantId}/{uuid}.{ext}` |
| Thumbnail Key | `{tenantId}/thumbs/{uuid}.webp` |
| Folder Organization | MongoDB `folderId` field on file documents |
| Folder Tree | Materialized path pattern: `/rootId/childId/grandchildId` |
| Max Folder Depth | 5 levels |

---

## Domain Models

### FileType

```typescript
class FileType {
  id: string;
  tenantId: string;
  path: string;            // S3 key — NEVER exposed to frontend
  fileName?: string;
  mimeType?: string;
  fileSize?: number;        // bytes
  checksum?: string;        // SHA-256 — excluded from API responses
  category?: 'general' | 'omni_media' | 'ticket_attachment';
  source?: 'upload' | 'omni_inbound' | 'omni_outbound' | 'system';
  status?: 'uploading' | 'ready' | 'failed' | 'deleted';
  uploadedBy?: string;
  accessLevel?: 'private' | 'tenant' | 'public';
  allowedUserIds?: string[];
  conversationId?: string;
  messageId?: string;       // used for omni_media dedup
  thumbnailKey?: string;    // S3 key for thumbnail
  imageMetadata?: {
    width?: number;
    height?: number;
    duration?: number;       // audio/video
    originalMimeType?: string;
    originalSize?: number;
  };
  tags?: string[];
  folderId?: string;        // null/undefined = root
  isDeleted?: boolean;
  deletedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}
```

### FolderType

```typescript
class FolderType {
  id: string;
  tenantId: string;
  name: string;             // 1–100 chars, unique per parent
  parentId: string | null;  // null = root level
  path: string;             // materialized path: /id1/id2/id3
  depth: number;            // 0 = root, max 5
  createdBy: string;
  color?: string;           // UI accent color (e.g., '#6366f1')
  isDeleted?: boolean;
  deletedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}
```

---

## REST API Endpoints

### File Endpoints (`/api/v1/files`)

| Method | Path | Permission | Description |
|---|---|---|---|
| `POST` | `/files/upload` | `files:create` | Upload a file (multipart/form-data) |
| `GET` | `/files` | `files:view` | List files with filtering + pagination |
| `GET` | `/files/search` | `files:view` | Full-text search by filename |
| `GET` | `/files/trash` | `files:view` | List soft-deleted files |
| `GET` | `/files/:id` | `files:view` | File detail with presigned download URL |
| `GET` | `/files/:id/download` | `files:view` | Get presigned download URL (1h expiry) |
| `PATCH` | `/files/:id/rename` | `files:edit` | Rename a file |
| `PATCH` | `/files/:id/move` | `files:edit` | Move file to a different folder |
| `PATCH` | `/files/:id/access` | `files:edit` | Update access level (private/tenant/public) |
| `POST` | `/files/bulk/move` | `files:edit` | Bulk move files to a folder |
| `POST` | `/files/bulk/delete` | `files:delete` | Bulk soft-delete files |
| `DELETE` | `/files/:id` | `files:delete` | Soft-delete a file (recoverable) |
| `DELETE` | `/files/:id/purge` | OWNER only | Hard-delete from S3 + DB (permanent) |
| `POST` | `/files/:id/restore` | `files:edit` | Restore from trash |
| `GET` | `/files/storage/usage` | `storage:view` | Storage quota + breakdown overview |

### Folder Endpoints (`/api/v1/folders`)

| Method | Path | Permission | Description |
|---|---|---|---|
| `POST` | `/folders` | `files:edit` | Create a new folder |
| `GET` | `/folders` | `files:view` | List all folders (flat, for client-side tree assembly) |
| `GET` | `/folders/:id` | `files:view` | Folder detail |
| `PATCH` | `/folders/:id` | `files:edit` | Rename, move, or change color |
| `DELETE` | `/folders/:id` | `files:edit` | Soft-delete a folder |
| `POST` | `/folders/:id/restore` | `files:edit` | Restore from trash |
| `DELETE` | `/folders/:id/purge` | OWNER only | Hard-delete (permanent) |

---

## Upload Flow

### Sequence

```
1. User selects file(s) → Frontend sends POST /files/upload (multipart/form-data)
2. Controller validates:
   ├── File extension against allowlist
   ├── MIME type against allowlist
   ├── File size against maxFileSize config (default 25MB)
   └── Tenant storage quota (atomic increment)
3. If image → ImageProcessingService:
   ├── Compress to WebP (quality 80, max 2048px)
   ├── Generate 200×200 thumbnail
   └── Extract width/height metadata
4. Upload to S3:
   ├── Main file → {tenantId}/{uuid}.{ext}
   └── Thumbnail → {tenantId}/thumbs/{uuid}.webp
5. Compute SHA-256 checksum
6. Upsert DB record via FilesService.upsertByMessageId()
7. Return { file: FileType } with presigned URLs
```

### Upload DTO

```typescript
// POST /files/upload — multipart/form-data
{
  file: File;                           // required — the binary file
  category?: 'general' | 'omni_media' | 'ticket_attachment';
  accessLevel?: 'private' | 'tenant' | 'public';  // default: 'tenant'
  folderId?: string;                    // target folder ID (null = root)
  conversationId?: string;             // link to omni conversation
  tags?: string[];                     // tagging metadata
}
```

### Quota Management

Storage quota is enforced atomically at upload time:
1. **Increment** tenant storage counter before S3 upload
2. If upload fails → **rollback** (decrement counter)
3. On hard-delete → **decrement** freed bytes

Only `general` category files count toward quota (omni_media and ticket_attachment are excluded).

---

## File Security

### Extension Allowlist

| Category | Extensions |
|---|---|
| **Images** | `jpg`, `jpeg`, `png`, `gif`, `webp` |
| **Documents** | `pdf`, `doc`, `docx`, `xls`, `xlsx`, `ppt`, `pptx`, `csv`, `txt` |
| **Media** | `mp4`, `webm`, `mp3`, `ogg`, `wav`, `aac`, `amr` |

### MIME Type Allowlist

All corresponding MIME types for the above extensions are validated. Both extension and MIME type must pass validation.

### Magic Byte Detection

The `detectMimeFromBuffer()` utility inspects file header bytes to detect true file type, supporting:
- JPEG (`FF D8 FF`)
- PNG (`89 50 4E 47`)
- GIF (`GIF87a` / `GIF89a`)
- WebP (`RIFF....WEBP`)
- PDF (`%PDF`)
- MP4 (`....ftyp`)
- MP3 (ID3 / MPEG sync)
- OGG (`OggS`)
- WAV (`RIFF....WAVE`)
- WebM (EBML header)

### Access Control

Three-tier ACL model:

| Level | Who Can Access |
|---|---|
| `public` | Anyone |
| `tenant` | All members of the tenant |
| `private` | Only `uploadedBy` user + explicit `allowedUserIds[]` |

**OWNER** and **ADMIN** roles bypass all ACL checks.

---

## Image Processing

The `ImageProcessingService` (powered by **sharp/libvips**) handles:

### Storage Compression

All uploaded images are automatically compressed:
- Format: **WebP** (quality 80)
- Max dimensions: **2048 × 2048** (preserves aspect ratio)
- Target size: < 5 MB

### Platform-Specific Compression

When sending images via omni-channel, platform-specific presets are applied:

| Platform | Max Size | Max Dimensions | Format | Quality |
|---|---|---|---|---|
| **Zalo** | 1 MB | 1024 × 1024 | JPEG | 75 → 40 |
| **WhatsApp** | 5 MB | 1600 × 1600 | JPEG | 80 → 55 |
| **Facebook** | 25 MB | 2048 × 2048 | JPEG | 85 → 65 |
| **Instagram** | 25 MB | 2048 × 2048 | JPEG | 85 → 65 |
| **LiveChat** | 25 MB | 2048 × 2048 | WebP | 85 → 60 |
| **Email** | 25 MB | 2048 × 2048 | JPEG | 85 → 60 |

Uses iterative quality reduction (up to 5 attempts):
1. Compress at preset quality
2. If over limit → reduce quality by 15
3. If at min quality → reduce dimensions by 20%
4. Final fallback: 640×640 at minimum quality

### Thumbnail Generation

- Size: **200 × 200** pixels
- Format: **WebP** (quality 60)
- Crop mode: `cover` (center crop)
- Stored at: `{tenantId}/thumbs/{uuid}.webp`

---

## Folder System

### Materialized Path Pattern

Folders use materialized paths for efficient tree operations:

```
/folder1                    → depth 0
/folder1/folder2            → depth 1
/folder1/folder2/folder3    → depth 2
```

### Constraints

| Constraint | Value |
|---|---|
| Max depth | 5 levels |
| Name length | 1–100 characters |
| Unique name | Per parent (no duplicate sibling names) |
| Circular move | Prevented (cannot move folder into its descendant) |

### Folder Operations

- **Create**: Validates parent exists, checks depth limit, generates materialized path
- **Move**: Updates path + depth for folder and all descendants atomically
- **Rename**: Validates unique name under same parent
- **Color**: Custom color accent for UI display
- **Delete**: Soft-delete with restore capability; OWNER can hard-delete

### Permission Model

- **Creator** or **ADMIN/OWNER** can rename, move, delete folders
- All tenant members with `files:view` can see all folders
- Folder access does not override file-level ACL

---

## MongoDB Schema & Indexes

### Files Collection

```javascript
// Compound indexes
{ tenantId: 1, status: 1, isDeleted: 1, category: 1 }    // primary listing
{ tenantId: 1, conversationId: 1 }                         // conversation files
{ tenantId: 1, messageId: 1 }                              // dedup (unique, sparse)
{ tenantId: 1, uploadedBy: 1, isDeleted: 1 }              // user's files
{ tenantId: 1, checksum: 1 }                               // content dedup (sparse)
{ tenantId: 1, folderId: 1, isDeleted: 1 }                // folder listing (sparse)
```

### Folders Collection

```javascript
{ tenantId: 1, parentId: 1, isDeleted: 1 }                // tree listing
{ tenantId: 1, path: 1 }                                   // descendant queries
{ tenantId: 1, parentId: 1, name: 1 }                     // unique name (unique, sparse)
```

---

## Frontend Architecture

### Module Structure

```
crm-web/src/features/drive/
├── index.ts                    # Public API exports
├── types.ts                    # TypeScript interfaces
├── services/
│   └── driveService.ts         # API client (axios)
├── store/
│   └── useDriveStore.ts        # Zustand state management
├── hooks/
│   └── useImagePicker.ts       # Image selection hook
└── ui/
    ├── CloudDrivePage.tsx       # Main drive page
    ├── StorageDashboardPage.tsx # Storage overview page
    └── components/
        ├── FolderTree.tsx       # Sidebar folder navigation
        ├── FileGrid.tsx        # Grid view (thumbnails)
        ├── FileList.tsx        # Table/list view
        ├── Breadcrumbs.tsx     # Folder path breadcrumbs
        ├── UploadZone.tsx      # Drag & drop upload area
        ├── FileDetailPanel.tsx # Right sidebar file details
        ├── CreateFolderDialog.tsx
        ├── RenameDialog.tsx
        ├── MoveToDialog.tsx
        ├── ImageLibraryPicker.tsx    # Reusable image picker (used by other modules)
        ├── FilePermissionEditor.tsx  # ACL editor component
        ├── QuotaDonutChart.tsx       # Storage quota visualization
        ├── CategoryBreakdownCard.tsx  # Storage breakdown by category
        └── TopFilesTable.tsx          # Largest files table
```

### State Management (Zustand)

The `useDriveStore` manages:

| State | Description |
|---|---|
| `folders` / `folderTree` | Flat list + computed tree structure |
| `currentFolderId` | Currently navigated folder |
| `files` / `totalFiles` | Paginated file listing |
| `uploadQueue` | Active upload progress tracking |
| `viewMode` | `grid` or `list` display mode |
| `selectedIds` | Multi-select for bulk operations |
| `searchQuery` | Full-text search filter |
| `isTrashView` | Toggle for trash view |
| `breadcrumbs` | Computed folder path |

### Key Frontend Flows

1. **Upload into folder**: `uploadFiles()` reads `currentFolderId` from store → passes to `driveService.uploadFile({ folderId })` → appended to FormData
2. **Navigate folder**: `navigateToFolder()` → updates `currentFolderId` → auto-expands parent chain in tree → fetches files for folder
3. **Drag & drop**: `UploadZone` captures file drop → triggers `uploadFiles()` with current folder context
4. **Search**: Debounced search via `setSearchQuery()` → calls `/files/search` API
5. **Bulk ops**: Multi-select files → bulk move/delete via toolbar actions

---

## Storage Dashboard

The Storage Dashboard (`/files/storage/usage`) provides:

| Metric | Source |
|---|---|
| Quota usage (used / limit) | `TenantsService.getStorageBreakdown()` |
| Category breakdown | Aggregated from file records |
| Top 10 largest files | Sorted by `fileSize` descending |
| Total file count | `FileRepository.countByTenant()` |
| Recent uploads (7 days) | `FileRepository.countRecentUploads()` |

---

## Configuration

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `FILE_DRIVER` | `s3-presigned` | Storage driver: `local`, `s3`, `s3-presigned` |
| `ACCESS_KEY_ID` | — | AWS/S3 access key |
| `SECRET_ACCESS_KEY` | — | AWS/S3 secret key |
| `AWS_DEFAULT_S3_BUCKET` | — | S3 bucket name |
| `AWS_S3_REGION` | — | S3 region |
| `AWS_S3_ENDPOINT` | — | Custom S3 endpoint (for DigitalOcean Spaces, MinIO) |
| `FILE_MAX_FILE_SIZE` | `26214400` (25MB) | Max upload size in bytes |
| `FILE_MAX_VIDEO_SIZE` | `104857600` (100MB) | Max video upload size |

### Storage Drivers

| Driver | Description | Use Case |
|---|---|---|
| `local` | Local filesystem | Development only |
| `s3` | Direct S3 upload (server-side) | Production (used by Cloud Drive) |
| `s3-presigned` | Presigned URL flow (client-side upload) | Legacy upload endpoints |

---

## Module Dependencies

```
FilesModule
├── DocumentFilePersistenceModule   (MongoDB file/folder repos)
├── MulterModule                     (in-memory file buffering)
├── MongooseModule                   (folder schema registration)
├── TenantsModule                    (storage quota management)
├── FilesService                     (core file CRUD + ACL)
├── ImageProcessingService           (sharp — compression + thumbnails)
├── FolderService                    (folder tree management)
└── FolderDocumentRepository         (MongoDB folder operations)

Exports: FilesService, ImageProcessingService, FolderService
Used by: OmniInbound (media attachments), OmniOutbound (media sending)
```

---

## Related Modules

| Module | Relationship |
|---|---|
| **Omni-Inbound** | Uses `FilesService.upsertByMessageId()` for media dedup |
| **Omni-Outbound** | Uses `ImageProcessingService.compressForPlatform()` for platform-specific image sizing |
| **Tenants** | Provides storage quota enforcement via `TenantsService.incrementStorageUsage()` |
| **Permissions** | `files` and `storage` are registered as permission resources |
