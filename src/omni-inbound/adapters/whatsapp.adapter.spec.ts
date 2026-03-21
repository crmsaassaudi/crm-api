import { WhatsAppAdapter } from '../adapters/whatsapp.adapter';

describe('WhatsAppAdapter', () => {
  let adapter: WhatsAppAdapter;

  beforeEach(() => {
    adapter = new WhatsAppAdapter();
  });

  describe('channelType', () => {
    it('should return "whatsapp"', () => {
      expect(adapter.channelType).toBe('whatsapp');
    });
  });

  describe('normalize', () => {
    it('should normalize a text message', () => {
      const raw = {
        messaging_product: 'whatsapp',
        metadata: {
          phone_number_id: 'phone_123',
          display_phone_number: '+1234567890',
        },
        contacts: [
          { profile: { name: 'John' }, wa_id: 'wa_001' },
        ],
        messages: [
          {
            from: 'wa_001',
            id: 'wamid.abc123',
            timestamp: '1700000000',
            type: 'text',
            text: { body: 'Hello from WhatsApp!' },
          },
        ],
      };

      const result = adapter.normalize(raw, 'tenant_1', 'channel_1');

      expect(result.channelType).toBe('whatsapp');
      expect(result.senderId).toBe('wa_001');
      expect(result.messageType).toBe('text');
      expect(result.content).toBe('Hello from WhatsApp!');
      expect(result.externalMessageId).toBe('wamid.abc123');
      expect(result.externalConversationId).toBe('wa_001_phone_123');
      expect(result.timestamp).toEqual(new Date(1700000000000));
      expect(result.metadata.contactName).toBe('John');
    });

    it('should normalize an image message with media ID', () => {
      const raw = {
        messaging_product: 'whatsapp',
        metadata: { phone_number_id: 'phone_123' },
        contacts: [{ profile: { name: 'Jane' }, wa_id: 'wa_002' }],
        messages: [
          {
            from: 'wa_002',
            id: 'wamid.img001',
            timestamp: '1700000000',
            type: 'image',
            image: {
              id: 'media_img_001',
              mime_type: 'image/jpeg',
              sha256: 'abc123',
              caption: 'Check this out!',
            },
          },
        ],
      };

      const result = adapter.normalize(raw, 'tenant_1', 'channel_1');

      expect(result.messageType).toBe('image');
      expect(result.content).toBe('Check this out!');
      expect(result.mediaUrl).toBe('media_img_001');
      expect(result.metadata.mediaId).toBe('media_img_001');
      expect(result.metadata.mimeType).toBe('image/jpeg');
    });

    it('should normalize a document message', () => {
      const raw = {
        messaging_product: 'whatsapp',
        metadata: { phone_number_id: 'phone_123' },
        contacts: [],
        messages: [
          {
            from: 'wa_003',
            id: 'wamid.doc001',
            timestamp: '1700000000',
            type: 'document',
            document: {
              id: 'media_doc_001',
              mime_type: 'application/pdf',
              sha256: 'def456',
              filename: 'invoice.pdf',
            },
          },
        ],
      };

      const result = adapter.normalize(raw, 'tenant_1', 'channel_1');

      expect(result.messageType).toBe('file');
      expect(result.metadata.mediaId).toBe('media_doc_001');
    });

    it('should normalize a location message', () => {
      const raw = {
        messaging_product: 'whatsapp',
        metadata: { phone_number_id: 'phone_123' },
        contacts: [],
        messages: [
          {
            from: 'wa_004',
            id: 'wamid.loc001',
            timestamp: '1700000000',
            type: 'location',
            location: {
              latitude: 10.762622,
              longitude: 106.660172,
              name: 'Ho Chi Minh City',
              address: 'Vietnam',
            },
          },
        ],
      };

      const result = adapter.normalize(raw, 'tenant_1', 'channel_1');

      expect(result.messageType).toBe('location');
      expect(result.content).toContain('Ho Chi Minh City');
      expect(result.content).toContain('10.762622');
      expect(result.mediaUrl).toBeUndefined();
    });

    it('should throw if no messages in payload', () => {
      const raw = {
        messaging_product: 'whatsapp',
        metadata: {},
        contacts: [],
        messages: [],
      };

      expect(() => adapter.normalize(raw, 'tenant_1', 'channel_1')).toThrow(
        'WhatsApp webhook has no messages',
      );
    });
  });
});
