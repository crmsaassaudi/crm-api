/**
 * ILivechatGateway — interface for the LivechatGateway sendToVisitor contract.
 *
 * Shared between LivechatAdapter (consumer) and LivechatGateway (implementor)
 * to ensure compile-time safety when the payload shape changes.
 *
 * G2 FIX: Exposes `url` (pre-resolved presigned URL) instead of `fileId`,
 * so the visitor widget can render media directly.
 */
export interface ILivechatGateway {
  sendToVisitor(
    visitorId: string,
    payload:
      | { type: 'text'; content: string; messageId?: string }
      | {
          type: 'image' | 'video' | 'audio' | 'file';
          url?: string;
          mimeType: string;
          fileName: string;
          fileSize?: number;
          thumbnailUrl?: string;
          messageId?: string;
        }
      | { type: 'carousel'; content?: string; cards: any[]; messageId?: string }
      | {
          type: 'interactive';
          content: string;
          buttons: any[];
          messageId?: string;
        },
  ): void;
}
