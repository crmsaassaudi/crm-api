import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { EntityDocumentHelper } from '../../../../../utils/document-entity-helper';

export type FileSchemaDocument = HydratedDocument<FileSchemaClass>;

@Schema({
  timestamps: true,
  optimisticConcurrency: true,
  versionKey: '__v',
  collection: 'files',
  toJSON: {
    virtuals: true,
    getters: true,
    transform: (doc, ret: any) => {
      ret.version = ret.__v;
      delete ret.__v;
      return ret;
    },
  },
})
export class FileSchemaClass extends EntityDocumentHelper {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'TenantSchemaClass',
    required: true,
    index: true,
  })
  tenantId: string;

  /** S3 object key — NEVER expose directly to frontend */
  @Prop({ required: true })
  path: string;

  // ── Basic Metadata ─────────────────────────────────────────────
  @Prop()
  fileName?: string;

  @Prop()
  mimeType?: string;

  @Prop()
  fileSize?: number;

  @Prop()
  checksum?: string;

  // ── Classification ────────────────────────────────────────────
  @Prop({ default: 'general' })
  category?: string;

  @Prop({ default: 'upload' })
  source?: string;

  @Prop({ default: 'ready' })
  status?: string;

  // ── Ownership & ACL ───────────────────────────────────────────
  @Prop()
  uploadedBy?: string;

  @Prop({ default: 'tenant' })
  accessLevel?: string;

  @Prop({ type: [String], default: [] })
  allowedUserIds?: string[];

  // ── Conversation Linking ──────────────────────────────────────
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'OmniConversationSchemaClass',
  })
  conversationId?: string;

  @Prop()
  messageId?: string;

  // ── Thumbnail ─────────────────────────────────────────────────
  @Prop()
  thumbnailKey?: string;

  // ── Image/Media Metadata ──────────────────────────────────────
  @Prop({ type: MongooseSchema.Types.Mixed })
  imageMetadata?: {
    width?: number;
    height?: number;
    duration?: number;
    originalMimeType?: string;
    originalSize?: number;
  };

  // ── Tags ──────────────────────────────────────────────────────
  @Prop({ type: [String], default: [] })
  tags?: string[];

  // ── Folder Linking ────────────────────────────────────────────
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'FolderSchemaClass',
  })
  folderId?: string;

  // ── Soft Delete ───────────────────────────────────────────────
  @Prop({ default: false })
  isDeleted?: boolean;

  @Prop()
  deletedAt?: Date;
}

export const FileSchema = SchemaFactory.createForClass(FileSchemaClass);

// ── Compound Indexes ────────────────────────────────────────────
// Primary query: list files by tenant, status, category
FileSchema.index(
  { tenantId: 1, status: 1, isDeleted: 1, category: 1 },
  { background: true },
);

// Conversation file history
FileSchema.index(
  { tenantId: 1, conversationId: 1 },
  { background: true, sparse: true },
);

// Dedup: one file record per message (omni_media idempotency)
FileSchema.index(
  { tenantId: 1, messageId: 1 },
  { background: true, sparse: true, unique: true },
);

// User's uploaded files
FileSchema.index(
  { tenantId: 1, uploadedBy: 1, isDeleted: 1 },
  { background: true },
);

// Dedup by checksum
FileSchema.index(
  { tenantId: 1, checksum: 1 },
  { background: true, sparse: true },
);

// Folder-based file listing (Cloud Drive)
FileSchema.index(
  { tenantId: 1, folderId: 1, isDeleted: 1 },
  { background: true, sparse: true },
);
