/**
 * Shared MIME → message type mapping.
 *
 * Used by LivechatAdapter, LivechatInboundBridge, OutboundService,
 * and any future channel adapter that needs this classification.
 */
export function mimeToMessageType(
  mimeType: string,
): 'image' | 'video' | 'audio' | 'file' {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  return 'file';
}
