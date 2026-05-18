const ALLOWED_IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif']);
const ALLOWED_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
]);

export function isAllowedImageFileName(fileName: string): boolean {
  const extension = fileName.split('.').pop()?.toLowerCase();
  return !!extension && ALLOWED_IMAGE_EXTENSIONS.has(extension);
}

export function isAllowedImageMimeType(mimeType?: string): boolean {
  return !!mimeType && ALLOWED_IMAGE_MIME_TYPES.has(mimeType.toLowerCase());
}

export function detectAllowedImageMimeFromBuffer(
  buffer: Buffer,
): string | null {
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return 'image/jpeg';
  }

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

  const gifHeader = buffer.subarray(0, 6).toString('ascii');
  if (gifHeader === 'GIF87a' || gifHeader === 'GIF89a') {
    return 'image/gif';
  }

  return null;
}
