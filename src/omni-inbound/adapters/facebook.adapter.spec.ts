import { FacebookAdapter } from '../adapters/facebook.adapter';

describe('FacebookAdapter', () => {
  let adapter: FacebookAdapter;

  beforeEach(() => {
    adapter = new FacebookAdapter();
  });

  describe('channelType', () => {
    it('should return "facebook"', () => {
      expect(adapter.channelType).toBe('facebook');
    });
  });

  describe('normalize', () => {
    it('should normalize a text message', () => {
      const raw = {
        sender: { id: 'psid_123' },
        recipient: { id: 'page_456' },
        timestamp: 1700000000000,
        message: {
          mid: 'mid.abc123',
          text: 'Hello, world!',
        },
      };

      const result = adapter.normalize(raw, 'tenant_1', 'channel_1');

      expect(result.tenantId).toBe('tenant_1');
      expect(result.channelId).toBe('channel_1');
      expect(result.channelType).toBe('facebook');
      expect(result.senderId).toBe('psid_123');
      expect(result.senderType).toBe('customer');
      expect(result.messageType).toBe('text');
      expect(result.content).toBe('Hello, world!');
      expect(result.externalMessageId).toBe('mid.abc123');
      expect(result.externalConversationId).toBe('psid_123_page_456');
      expect(result.timestamp).toEqual(new Date(1700000000000));
      expect(result.mediaUrl).toBeUndefined();
    });

    it('should normalize an image message', () => {
      const raw = {
        sender: { id: 'psid_123' },
        recipient: { id: 'page_456' },
        timestamp: 1700000000000,
        message: {
          mid: 'mid.img001',
          attachments: [
            {
              type: 'image',
              payload: { url: 'https://cdn.fb.com/image.jpg' },
            },
          ],
        },
      };

      const result = adapter.normalize(raw, 'tenant_1', 'channel_1');

      expect(result.messageType).toBe('image');
      expect(result.mediaUrl).toBe('https://cdn.fb.com/image.jpg');
      expect(result.content).toBe('');
    });

    it('should normalize a video message', () => {
      const raw = {
        sender: { id: 'psid_123' },
        recipient: { id: 'page_456' },
        timestamp: 1700000000000,
        message: {
          mid: 'mid.vid001',
          attachments: [
            {
              type: 'video',
              payload: { url: 'https://cdn.fb.com/video.mp4' },
            },
          ],
        },
      };

      const result = adapter.normalize(raw, 'tenant_1', 'channel_1');

      expect(result.messageType).toBe('video');
      expect(result.mediaUrl).toBe('https://cdn.fb.com/video.mp4');
    });

    it('should preserve metadata fields', () => {
      const raw = {
        sender: { id: 'psid_123' },
        recipient: { id: 'page_456' },
        timestamp: 1700000000000,
        message: {
          mid: 'mid.abc123',
          text: 'Hi',
          quick_reply: { payload: 'YES' },
          reply_to: { mid: 'mid.prev001' },
        },
      };

      const result = adapter.normalize(raw, 'tenant_1', 'channel_1');

      expect(result.metadata.mid).toBe('mid.abc123');
      expect(result.metadata.quickReply).toEqual({ payload: 'YES' });
      expect(result.metadata.replyTo).toEqual({ mid: 'mid.prev001' });
    });
  });
});
