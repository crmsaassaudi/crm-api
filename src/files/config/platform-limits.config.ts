import { ChannelType } from '../../omni-inbound/domain/omni-payload';

/**
 * Per-media-type limit for a specific platform.
 * `null` means this media type is NOT supported on the platform.
 */
export interface MediaTypeLimit {
  /** Maximum file size in bytes */
  maxBytes: number;
  /** Allowed file extensions (lowercase, no dot) */
  formats: string[];
  /** Allowed MIME types */
  mimeTypes: string[];
}

export interface PlatformMediaLimit {
  image: MediaTypeLimit | null;
  video: MediaTypeLimit | null;
  audio: MediaTypeLimit | null;
  file: MediaTypeLimit | null;
}

/**
 * Centralized platform file limits.
 *
 * Used by:
 * - OutboundService: validate + compress before sending
 * - Upload validation: warn users about platform-specific limits
 * - ImageProcessingService: target size for compression
 *
 * Sources:
 * - Facebook Messenger API: 25 MB all types
 * - Zalo OA API: 1 MB image (jpg/png), 5 MB file (pdf/doc/docx)
 * - WhatsApp Business API: 5 MB image, 16 MB video/audio, 64 MB document
 * - LiveChat: mirrors Facebook limits
 */
export const PLATFORM_LIMITS: Record<ChannelType, PlatformMediaLimit> = {
  facebook: {
    image: {
      maxBytes: 25 * 1024 * 1024,
      formats: ['jpg', 'jpeg', 'png', 'gif'],
      mimeTypes: ['image/jpeg', 'image/png', 'image/gif'],
    },
    video: {
      maxBytes: 25 * 1024 * 1024,
      formats: ['mp4'],
      mimeTypes: ['video/mp4'],
    },
    audio: {
      maxBytes: 25 * 1024 * 1024,
      formats: ['mp3', 'ogg', 'wav'],
      mimeTypes: ['audio/mpeg', 'audio/ogg', 'audio/wav'],
    },
    file: {
      maxBytes: 25 * 1024 * 1024,
      formats: [
        'pdf',
        'doc',
        'docx',
        'xls',
        'xlsx',
        'ppt',
        'pptx',
        'csv',
        'txt',
      ],
      mimeTypes: [
        'application/pdf',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.ms-excel',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.ms-powerpoint',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'text/csv',
        'text/plain',
      ],
    },
  },

  instagram: {
    image: {
      maxBytes: 25 * 1024 * 1024,
      formats: ['jpg', 'jpeg', 'png'],
      mimeTypes: ['image/jpeg', 'image/png'],
    },
    video: {
      maxBytes: 25 * 1024 * 1024,
      formats: ['mp4'],
      mimeTypes: ['video/mp4'],
    },
    audio: null,
    file: null,
  },

  zalo: {
    image: {
      maxBytes: 1 * 1024 * 1024, // 1 MB — very strict
      formats: ['jpg', 'jpeg', 'png'],
      mimeTypes: ['image/jpeg', 'image/png'],
    },
    video: null, // Zalo OA API does not support video sending
    audio: null, // Zalo OA API does not support audio sending
    file: {
      maxBytes: 5 * 1024 * 1024, // 5 MB
      formats: ['pdf', 'doc', 'docx'],
      mimeTypes: [
        'application/pdf',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ],
    },
  },

  whatsapp: {
    image: {
      maxBytes: 5 * 1024 * 1024,
      formats: ['jpg', 'jpeg', 'png'],
      mimeTypes: ['image/jpeg', 'image/png'],
    },
    video: {
      maxBytes: 16 * 1024 * 1024,
      formats: ['mp4'],
      mimeTypes: ['video/mp4'],
    },
    audio: {
      maxBytes: 16 * 1024 * 1024,
      formats: ['aac', 'mp4', 'ogg', 'amr'],
      mimeTypes: ['audio/aac', 'audio/mp4', 'audio/ogg', 'audio/amr'],
    },
    file: {
      maxBytes: 64 * 1024 * 1024,
      formats: [
        'pdf',
        'doc',
        'docx',
        'xls',
        'xlsx',
        'ppt',
        'pptx',
        'csv',
        'txt',
      ],
      mimeTypes: [
        'application/pdf',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.ms-excel',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.ms-powerpoint',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'text/csv',
        'text/plain',
      ],
    },
  },

  livechat: {
    image: {
      maxBytes: 25 * 1024 * 1024,
      formats: ['jpg', 'jpeg', 'png', 'gif', 'webp'],
      mimeTypes: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
    },
    video: {
      maxBytes: 25 * 1024 * 1024,
      formats: ['mp4', 'webm'],
      mimeTypes: ['video/mp4', 'video/webm'],
    },
    audio: {
      maxBytes: 25 * 1024 * 1024,
      formats: ['mp3', 'ogg', 'wav'],
      mimeTypes: ['audio/mpeg', 'audio/ogg', 'audio/wav'],
    },
    file: {
      maxBytes: 25 * 1024 * 1024,
      formats: [
        'pdf',
        'doc',
        'docx',
        'xls',
        'xlsx',
        'ppt',
        'pptx',
        'csv',
        'txt',
      ],
      mimeTypes: [
        'application/pdf',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.ms-excel',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.ms-powerpoint',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'text/csv',
        'text/plain',
      ],
    },
  },

  email: {
    image: {
      maxBytes: 25 * 1024 * 1024,
      formats: ['jpg', 'jpeg', 'png', 'gif', 'webp'],
      mimeTypes: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
    },
    video: {
      maxBytes: 25 * 1024 * 1024,
      formats: ['mp4'],
      mimeTypes: ['video/mp4'],
    },
    audio: {
      maxBytes: 25 * 1024 * 1024,
      formats: ['mp3', 'ogg'],
      mimeTypes: ['audio/mpeg', 'audio/ogg'],
    },
    file: {
      maxBytes: 25 * 1024 * 1024,
      formats: [
        'pdf',
        'doc',
        'docx',
        'xls',
        'xlsx',
        'ppt',
        'pptx',
        'csv',
        'txt',
        'zip',
      ],
      mimeTypes: [
        'application/pdf',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.ms-excel',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.ms-powerpoint',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'text/csv',
        'text/plain',
        'application/zip',
      ],
    },
  },
};

/**
 * Get the media type category from a MIME type string.
 * Used to look up the correct platform limit.
 */
export function getMediaTypeFromMime(
  mimeType: string,
): 'image' | 'video' | 'audio' | 'file' {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  return 'file';
}

/**
 * Validate a file against platform limits for outbound sending.
 *
 * @returns `null` if valid, or an error message string if invalid.
 */
export function validateForPlatform(
  channelType: ChannelType,
  mimeType: string,
  fileSize: number,
): string | null {
  const limits = PLATFORM_LIMITS[channelType];
  if (!limits) return `Unsupported channel type: ${channelType}`;

  const mediaType = getMediaTypeFromMime(mimeType);
  const limit = limits[mediaType];

  if (!limit) {
    return `${channelType} does not support ${mediaType} messages`;
  }

  if (!limit.mimeTypes.includes(mimeType.toLowerCase())) {
    return `${channelType} does not support MIME type ${mimeType} for ${mediaType}`;
  }

  if (fileSize > limit.maxBytes) {
    const maxMB = (limit.maxBytes / (1024 * 1024)).toFixed(0);
    const fileMB = (fileSize / (1024 * 1024)).toFixed(1);
    return `File size ${fileMB}MB exceeds ${channelType} ${mediaType} limit of ${maxMB}MB`;
  }

  return null;
}
