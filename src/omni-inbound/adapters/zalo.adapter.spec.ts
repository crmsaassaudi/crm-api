import { ZaloAdapter } from '../adapters/zalo.adapter';

describe('ZaloAdapter', () => {
  let adapter: ZaloAdapter;

  beforeEach(() => {
    adapter = new ZaloAdapter();
  });

  describe('channelType', () => {
    it('should return "zalo"', () => {
      expect(adapter.channelType).toBe('zalo');
    });
  });

  describe('normalize', () => {
    it('should normalize a text message', () => {
      const raw = {
        app_id: 'app_001',
        sender: { id: 'zalo_user_123' },
        recipient: { id: 'oa_456' },
        event_name: 'user_send_text',
        message: {
          msg_id: 'zmsg_001',
          text: 'Xin chào!',
        },
        timestamp: '1700000000000',
      };

      const result = adapter.normalize(raw, 'tenant_1', 'channel_1');

      expect(result[0].channelType).toBe('zalo');
      expect(result[0].senderId).toBe('zalo_user_123');
      expect(result[0].messageType).toBe('text');
      expect(result[0].content).toBe('Xin chào!');
      expect(result[0].externalMessageId).toBe('zmsg_001');
      expect(result[0].externalConversationId).toBe('zalo_user_123_oa_456');
      expect(result[0].timestamp).toEqual(new Date(1700000000000));
    });

    it('should normalize an image message with expiring URL', () => {
      const raw = {
        app_id: 'app_001',
        sender: { id: 'zalo_user_123' },
        recipient: { id: 'oa_456' },
        event_name: 'user_send_image',
        message: {
          msg_id: 'zmsg_002',
          attachments: [
            {
              type: 'image',
              payload: {
                url: 'https://zalo-cdn.com/image.jpg?token=expires_soon',
                thumbnail: 'https://zalo-cdn.com/thumb.jpg',
              },
            },
          ],
        },
        timestamp: '1700000000000',
      };

      const result = adapter.normalize(raw, 'tenant_1', 'channel_1');

      expect(result[0].messageType).toBe('image');
      expect(result[0].mediaUrl).toBe(
        'https://zalo-cdn.com/image.jpg?token=expires_soon',
      );
      expect(result[0].content).toBe('');
    });

    it('should normalize a file message', () => {
      const raw = {
        app_id: 'app_001',
        sender: { id: 'zalo_user_123' },
        recipient: { id: 'oa_456' },
        event_name: 'user_send_file',
        message: {
          msg_id: 'zmsg_003',
          attachments: [
            {
              type: 'file',
              payload: {
                url: 'https://zalo-cdn.com/doc.pdf',
                name: 'report.pdf',
                size: 1024,
              },
            },
          ],
        },
        timestamp: '1700000000000',
      };

      const result = adapter.normalize(raw, 'tenant_1', 'channel_1');

      expect(result[0].messageType).toBe('file');
      expect(result[0].mediaUrl).toBe('https://zalo-cdn.com/doc.pdf');
    });

    it('should normalize a sticker message', () => {
      const raw = {
        app_id: 'app_001',
        sender: { id: 'zalo_user_123' },
        recipient: { id: 'oa_456' },
        event_name: 'user_send_sticker',
        message: {
          msg_id: 'zmsg_004',
          attachments: [
            {
              type: 'sticker',
              payload: { url: 'https://zalo-cdn.com/sticker.png' },
            },
          ],
        },
        timestamp: '1700000000000',
      };

      const result = adapter.normalize(raw, 'tenant_1', 'channel_1');

      expect(result[0].messageType).toBe('sticker');
    });

    it('should preserve Zalo-specific metadata', () => {
      const raw = {
        app_id: 'app_001',
        sender: { id: 'zalo_user_123' },
        recipient: { id: 'oa_456' },
        event_name: 'user_send_text',
        message: { msg_id: 'zmsg_001', text: 'Hi' },
        timestamp: '1700000000000',
      };

      const result = adapter.normalize(raw, 'tenant_1', 'channel_1');

      expect(result[0].metadata.appId).toBe('app_001');
      expect(result[0].metadata.eventName).toBe('user_send_text');
      expect(result[0].metadata.oaId).toBe('oa_456');
    });
  });
});
