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
    it('should return null for delivery events', () => {
      const raw = {
        sender: { id: 'psid_123' },
        recipient: { id: 'page_456' },
        timestamp: 1700000000000,
        delivery: { mids: ['mid.xyz'], watermark: 1700000000000 },
      };
      const result = adapter.normalize(raw, 'tenant_1', 'channel_1');
      expect(result).toEqual([]);
    });

    it('should return null for read events', () => {
      const raw = {
        sender: { id: 'psid_123' },
        recipient: { id: 'page_456' },
        timestamp: 1700000000000,
        read: { watermark: 1700000000000 },
      };
      const result = adapter.normalize(raw, 'tenant_1', 'channel_1');
      expect(result).toEqual([]);
    });

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

      const result = adapter.normalize(raw, 'tenant_1', 'channel_1')!;

      expect(result[0].tenantId).toBe('tenant_1');
      expect(result[0].channelId).toBe('channel_1');
      expect(result[0].channelType).toBe('facebook');
      expect(result[0].senderId).toBe('psid_123');
      expect(result[0].senderType).toBe('customer');
      expect(result[0].messageType).toBe('text');
      expect(result[0].content).toBe('Hello, world!');
      expect(result[0].externalMessageId).toBe('mid.abc123');
      expect(result[0].externalConversationId).toBe('psid_123_page_456');
      expect(result[0].timestamp).toEqual(new Date(1700000000000));
      expect(result[0].mediaUrl).toBeUndefined();
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

      const result = adapter.normalize(raw, 'tenant_1', 'channel_1')!;

      expect(result[0].messageType).toBe('image');
      expect(result[0].mediaUrl).toBe('https://cdn.fb.com/image.jpg');
      expect(result[0].content).toBe('');
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

      const result = adapter.normalize(raw, 'tenant_1', 'channel_1')!;

      expect(result[0].messageType).toBe('video');
      expect(result[0].mediaUrl).toBe('https://cdn.fb.com/video.mp4');
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

      const result = adapter.normalize(raw, 'tenant_1', 'channel_1')!;

      expect(result[0].metadata.mid).toBe('mid.abc123');
      expect(result[0].metadata.quickReply).toEqual({ payload: 'YES' });
      expect(result[0].metadata.replyTo).toEqual({ mid: 'mid.prev001' });
    });
  });
});
