import { FileCategory } from './domain/file';

// ── Image Extensions & MIME Types ───────────────────────────────
const ALLOWED_IMAGE_EXTENSIONS = new Set([
  'jpg',
  'jpeg',
  'png',
  'gif',
  'webp',
]);
const ALLOWED_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

// ── Document Extensions & MIME Types ────────────────────────────
const ALLOWED_DOCUMENT_EXTENSIONS = new Set([
  'pdf',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'csv',
  'txt',
]);
const ALLOWED_DOCUMENT_MIME_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/csv',
  'text/plain',
]);

// ── Media Extensions & MIME Types ───────────────────────────────
const ALLOWED_MEDIA_EXTENSIONS = new Set([
  'mp4',
  'webm',
  'mp3',
  'ogg',
  'wav',
  'aac',
  'amr',
]);
const ALLOWED_MEDIA_MIME_TYPES = new Set([
  'video/mp4',
  'video/webm',
  'audio/mpeg',
  'audio/mp3',
  'audio/ogg',
  'audio/wav',
  'audio/aac',
  'audio/amr',
  'audio/mp4',
]);

// ── Combined ────────────────────────────────────────────────────
const ALLOWED_ALL_EXTENSIONS = new Set([
  ...ALLOWED_IMAGE_EXTENSIONS,
  ...ALLOWED_DOCUMENT_EXTENSIONS,
  ...ALLOWED_MEDIA_EXTENSIONS,
]);

const ALLOWED_ALL_MIME_TYPES = new Set([
  ...ALLOWED_IMAGE_MIME_TYPES,
  ...ALLOWED_DOCUMENT_MIME_TYPES,
  ...ALLOWED_MEDIA_MIME_TYPES,
]);

// ── Validators ──────────────────────────────────────────────────

/** Check if a filename has an allowed IMAGE extension */
export function isAllowedImageFileName(fileName: string): boolean {
  const extension = fileName.split('.').pop()?.toLowerCase();
  return !!extension && ALLOWED_IMAGE_EXTENSIONS.has(extension);
}

/** Check if a MIME type is an allowed IMAGE type */
export function isAllowedImageMimeType(mimeType?: string): boolean {
  return !!mimeType && ALLOWED_IMAGE_MIME_TYPES.has(mimeType.toLowerCase());
}

/** Check if a filename has any allowed extension (image/doc/media) */
export function isAllowedFileName(fileName: string): boolean {
  const extension = fileName.split('.').pop()?.toLowerCase();
  return !!extension && ALLOWED_ALL_EXTENSIONS.has(extension);
}

/** Check if a MIME type is any allowed type (image/doc/media) */
export function isAllowedMimeType(mimeType?: string): boolean {
  return !!mimeType && ALLOWED_ALL_MIME_TYPES.has(mimeType.toLowerCase());
}

// ── Category Detection ──────────────────────────────────────────

/**
 * Determine the file category from its MIME type.
 * Used by upload endpoints to auto-classify files.
 */
export function getFileCategory(mimeType: string): FileCategory {
  const lower = mimeType.toLowerCase();
  if (lower.startsWith('image/')) return 'general';
  if (lower.startsWith('video/') || lower.startsWith('audio/'))
    return 'general';
  if (ALLOWED_DOCUMENT_MIME_TYPES.has(lower)) return 'general';
  return 'general';
}

// ── Magic Byte Detection ────────────────────────────────────────

/**
 * Detect MIME type from file buffer magic bytes.
 * Supports images, PDF, and common media formats.
 * Returns null if format is unknown.
 */
export function detectMimeFromBuffer(buffer: Buffer): string | null {
  if (buffer.length < 4) return null;

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'image/png';
  }

  // GIF: GIF87a or GIF89a
  const gifHeader = buffer.subarray(0, 6).toString('ascii');
  if (gifHeader === 'GIF87a' || gifHeader === 'GIF89a') {
    return 'image/gif';
  }

  // WebP: RIFF....WEBP
  if (
    buffer.length >= 12 &&
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return 'image/webp';
  }

  // PDF: %PDF
  if (
    buffer[0] === 0x25 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x44 &&
    buffer[3] === 0x46
  ) {
    return 'application/pdf';
  }

  // MP4 / MOV: ....ftyp (offset 4)
  if (
    buffer.length >= 8 &&
    buffer[4] === 0x66 &&
    buffer[5] === 0x74 &&
    buffer[6] === 0x79 &&
    buffer[7] === 0x70
  ) {
    return 'video/mp4';
  }

  // MP3: ID3 tag or MPEG sync word
  if (
    (buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) || // ID3
    (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) // MPEG sync
  ) {
    return 'audio/mpeg';
  }

  // OGG: OggS
  if (
    buffer[0] === 0x4f &&
    buffer[1] === 0x67 &&
    buffer[2] === 0x67 &&
    buffer[3] === 0x53
  ) {
    return 'audio/ogg';
  }

  // WAV: RIFF....WAVE
  if (
    buffer.length >= 12 &&
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x41 &&
    buffer[10] === 0x56 &&
    buffer[11] === 0x45
  ) {
    return 'audio/wav';
  }

  // WebM: 1A 45 DF A3 (EBML header)
  if (
    buffer[0] === 0x1a &&
    buffer[1] === 0x45 &&
    buffer[2] === 0xdf &&
    buffer[3] === 0xa3
  ) {
    return 'video/webm';
  }

  return null;
}

/**
 * Legacy alias — kept for backward compatibility.
 * @deprecated Use `detectMimeFromBuffer` instead.
 */
export function detectAllowedImageMimeFromBuffer(
  buffer: Buffer,
): string | null {
  const mime = detectMimeFromBuffer(buffer);
  // Only return image MIME types for backward compat
  return mime && mime.startsWith('image/') ? mime : null;
}
