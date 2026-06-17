import { ApiProperty } from '@nestjs/swagger';
import { Allow, IsOptional } from 'class-validator';
import { Exclude, Transform } from 'class-transformer';
import fileConfig from '../config/file.config';
import { FileConfig, FileDriver } from '../config/file-config.type';

import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { AppConfig } from '../../config/app-config.type';
import appConfig from '../../config/app.config';

// ────────────────────────────────────────────────────────────────
// Enum types — shared between domain, schema, and DTOs
// ────────────────────────────────────────────────────────────────
export type FileCategory = 'general' | 'omni_media' | 'ticket_attachment';
export type FileSource = 'upload' | 'omni_inbound' | 'omni_outbound' | 'system';
export type FileStatus = 'uploading' | 'ready' | 'failed' | 'deleted';
export type FileAccessLevel = 'private' | 'tenant' | 'public';

export interface FileImageMetadata {
  width?: number;
  height?: number;
  /** Duration in seconds (video/audio) */
  duration?: number;
  /** MIME type before compression */
  originalMimeType?: string;
  /** Size in bytes before compression */
  originalSize?: number;
}

export class FileType {
  @ApiProperty({
    type: String,
    example: 'cbcfa8b8-3a25-4adb-a9c6-e325f0d0f3ae',
  })
  @Allow()
  id: string;

  @ApiProperty()
  tenantId: string;

  @ApiProperty()
  version?: number;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;

  // ── Storage Key ────────────────────────────────────────────────
  // NEVER expose the raw S3 key to frontend. The @Transform decorator
  // converts it to a presigned URL on serialization.
  @ApiProperty({
    type: String,
    example: 'https://example.com/path/to/file.jpg',
    description: 'Presigned download URL (auto-generated from S3 key)',
  })
  @Transform(
    ({ value }) => {
      if ((fileConfig() as FileConfig).driver === FileDriver.LOCAL) {
        return (appConfig() as AppConfig).backendDomain + value;
      } else if (
        [FileDriver.S3_PRESIGNED, FileDriver.S3].includes(
          (fileConfig() as FileConfig).driver,
        )
      ) {
        const s3 = new S3Client({
          region: (fileConfig() as FileConfig).awsS3Region ?? '',
          endpoint: (fileConfig() as FileConfig).awsS3Endpoint || undefined,
          forcePathStyle: !!(fileConfig() as FileConfig).awsS3Endpoint,
          credentials: {
            accessKeyId: (fileConfig() as FileConfig).accessKeyId ?? '',
            secretAccessKey: (fileConfig() as FileConfig).secretAccessKey ?? '',
          },
        });

        const command = new GetObjectCommand({
          Bucket: (fileConfig() as FileConfig).awsDefaultS3Bucket ?? '',
          Key: value,
        });

        return getSignedUrl(s3, command, { expiresIn: 3600 });
      }

      return value;
    },
    {
      toPlainOnly: true,
    },
  )
  path: string;

  // ── Basic Metadata ─────────────────────────────────────────────
  @ApiProperty({ example: 'report.pdf' })
  @IsOptional()
  fileName?: string;

  @ApiProperty({ example: 'application/pdf' })
  @IsOptional()
  mimeType?: string;

  @ApiProperty({ example: 245000, description: 'File size in bytes' })
  @IsOptional()
  fileSize?: number;

  @ApiProperty({ example: 'a1b2c3d4...', description: 'SHA-256 checksum' })
  @IsOptional()
  @Exclude({ toPlainOnly: true }) // Never expose checksum to frontend
  checksum?: string;

  // ── Classification ────────────────────────────────────────────
  @ApiProperty({ enum: ['general', 'omni_media', 'ticket_attachment'] })
  @IsOptional()
  category?: FileCategory;

  @ApiProperty({ enum: ['upload', 'omni_inbound', 'omni_outbound', 'system'] })
  @IsOptional()
  source?: FileSource;

  @ApiProperty({ enum: ['uploading', 'ready', 'failed', 'deleted'] })
  @IsOptional()
  status?: FileStatus;

  // ── Ownership & ACL ───────────────────────────────────────────
  @ApiProperty({ description: 'User ID who uploaded the file' })
  @IsOptional()
  uploadedBy?: string;

  @ApiProperty({ enum: ['private', 'tenant', 'public'] })
  @IsOptional()
  accessLevel?: FileAccessLevel;

  @ApiProperty({ type: [String], description: 'Extra user IDs with access' })
  @IsOptional()
  allowedUserIds?: string[];

  // ── Conversation Linking ──────────────────────────────────────
  @ApiProperty({ description: 'Linked omni conversation ID' })
  @IsOptional()
  conversationId?: string;

  @ApiProperty({ description: 'Linked omni message ID' })
  @IsOptional()
  messageId?: string;

  // ── Thumbnail ─────────────────────────────────────────────────
  @ApiProperty({ description: 'Presigned thumbnail URL' })
  @IsOptional()
  @Transform(
    ({ value }) => {
      if (!value) return undefined;
      if ((fileConfig() as FileConfig).driver === FileDriver.LOCAL) {
        return (appConfig() as AppConfig).backendDomain + value;
      } else if (
        [FileDriver.S3_PRESIGNED, FileDriver.S3].includes(
          (fileConfig() as FileConfig).driver,
        )
      ) {
        const s3 = new S3Client({
          region: (fileConfig() as FileConfig).awsS3Region ?? '',
          endpoint: (fileConfig() as FileConfig).awsS3Endpoint || undefined,
          forcePathStyle: !!(fileConfig() as FileConfig).awsS3Endpoint,
          credentials: {
            accessKeyId: (fileConfig() as FileConfig).accessKeyId ?? '',
            secretAccessKey: (fileConfig() as FileConfig).secretAccessKey ?? '',
          },
        });
        const command = new GetObjectCommand({
          Bucket: (fileConfig() as FileConfig).awsDefaultS3Bucket ?? '',
          Key: value,
        });
        return getSignedUrl(s3, command, { expiresIn: 3600 });
      }
      return value;
    },
    { toPlainOnly: true },
  )
  thumbnailKey?: string;

  // ── Image/Media Metadata ──────────────────────────────────────
  @ApiProperty({ type: Object, required: false })
  @IsOptional()
  imageMetadata?: FileImageMetadata;

  // ── Tags ──────────────────────────────────────────────────────
  @ApiProperty({ type: [String] })
  @IsOptional()
  tags?: string[];

  // ── Folder Linking ────────────────────────────────────────────
  @ApiProperty({
    description:
      'Folder ID for Cloud Drive organization. null/undefined = root.',
  })
  @IsOptional()
  folderId?: string;

  // ── Soft Delete ───────────────────────────────────────────────
  @ApiProperty()
  @IsOptional()
  isDeleted?: boolean;

  @ApiProperty()
  @IsOptional()
  deletedAt?: Date;
}
