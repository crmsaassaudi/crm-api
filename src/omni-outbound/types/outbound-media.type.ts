/**
 * Represents media attached to an outbound message.
 *
 * Two sources:
 * 1. Existing file → provide `fileId` (resolved from S3)
 * 2. Fresh upload → provide `buffer` + metadata
 */
export interface OutboundMedia {
  /** Reference to an existing file record in DB */
  fileId?: string;

  /** Raw file buffer (for fresh uploads via socket/API) */
  buffer?: Buffer;

  /** MIME type of the media */
  mimeType: string;

  /** Original filename */
  fileName: string;

  /** File size in bytes */
  size: number;

  /** Optional caption/text to send alongside the media */
  caption?: string;

  /** S3 storage key (resolved internally, not set by caller) */
  storageKey?: string;

  /** Resolved public URL (e.g. presigned S3 URL) for providers that require it (Instagram, Zalo) */
  url?: string;
}

/**
 * Result of adapter.sendMedia()
 */
export interface MediaSendResult {
  /** Provider-specific message ID */
  externalMessageId?: string;

  /** Provider-specific attachment/media ID */
  externalMediaId?: string;

  /** Whether the send was successful */
  success: boolean;

  /** Error message if failed */
  error?: string;
}
